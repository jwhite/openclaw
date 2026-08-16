// ha-voice tests cover the converse webhook's streaming and non-streaming response paths (S5.2).
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import type { CoreAgentDeps } from "./core-bridge.js";
import { createHaVoiceWebhookRequestHandler, type HaVoiceWebhookTarget } from "./http.js";
import { generateHaVoiceResponse } from "./response-generator.js";

vi.mock("./response-generator.js", () => ({ generateHaVoiceResponse: vi.fn() }));

const generateMock = vi.mocked(generateHaVoiceResponse);

const WEBHOOK_PATH = "/plugins/ha-voice/converse";
const SECRET = "test-secret";

function createRequest(params: { accept?: string; body?: unknown }): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & { socket: { remoteAddress: string } };
  req.method = "POST";
  req.url = WEBHOOK_PATH;
  req.headers = {
    "content-type": "application/json",
    authorization: `Bearer ${SECRET}`,
    ...(params.accept ? { accept: params.accept } : {}),
  };
  req.socket = { remoteAddress: "127.0.0.1" } as IncomingMessage["socket"];
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(params.body ?? { text: "hello" }), "utf8"));
    req.emit("end");
  });
  return req;
}

/** The shared createMockServerResponse helper only models setHeader/end, so it can't observe
 * streamed writes or the close listener the SSE path registers. */
function createStreamingResponse(): ServerResponse & {
  chunks: string[];
  headers: Record<string, string>;
} {
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};
  const res = Object.assign(emitter, {
    statusCode: 0,
    writableEnded: false,
    chunks: [] as string[],
    headers,
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
      return res;
    },
    getHeader(key: string) {
      return headers[key.toLowerCase()];
    },
    flushHeaders() {},
    write(chunk: string) {
      res.chunks.push(chunk);
      return true;
    },
    end(body?: string) {
      if (body) {
        res.chunks.push(body);
      }
      res.writableEnded = true;
      return res;
    },
  });
  return res as unknown as ServerResponse & { chunks: string[]; headers: Record<string, string> };
}

function parseSseEvents(chunks: string[]): Array<{ event: string; data: Record<string, unknown> }> {
  return chunks
    .join("")
    .split("\n\n")
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const eventLine = record.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = record.split("\n").find((line) => line.startsWith("data: "));
      return {
        event: eventLine?.slice("event: ".length) ?? "",
        data: JSON.parse(dataLine?.slice("data: ".length) ?? "{}") as Record<string, unknown>,
      };
    });
}

function createHandler() {
  const target: HaVoiceWebhookTarget = {
    path: WEBHOOK_PATH,
    secretInput: SECRET,
    secretConfigPath: "plugins.entries.ha-voice.config.secret",
    agentId: "main",
    sessionScope: "per-device",
    agentRuntime: {} as CoreAgentDeps,
  };
  return createHaVoiceWebhookRequestHandler({
    cfg: {} as OpenClawConfig,
    targetsByPath: new Map([[WEBHOOK_PATH, [target]]]),
  });
}

describe("ha-voice converse webhook streaming (S5.2)", () => {
  beforeEach(() => {
    generateMock.mockReset();
  });

  it("returns the existing single JSON body when streaming is not requested", async () => {
    generateMock.mockResolvedValue({
      text: "Lights are on.",
      continueConversation: false,
      traceId: "trace-1",
    });
    const res = createStreamingResponse();

    await createHandler()(createRequest({}), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.chunks.join(""))).toEqual({
      ok: true,
      response: "Lights are on.",
      continueConversation: false,
      traceId: "trace-1",
    });
    // The streaming callbacks must not be wired for a non-streaming caller (S5.1 gates real
    // per-token chunker work on their presence).
    const call = generateMock.mock.calls[0]?.[0];
    expect(call?.onSpokenChunk).toBeUndefined();
    expect(call?.onSpokenReset).toBeUndefined();
  });

  it("streams chunk events then a terminal done event when SSE is requested", async () => {
    generateMock.mockImplementation(async (args) => {
      args.onSpokenChunk?.("Lights are ");
      args.onSpokenChunk?.("on.");
      return { text: "Lights are on.", continueConversation: false, traceId: "trace-2" };
    });
    const res = createStreamingResponse();

    await createHandler()(createRequest({ accept: "text/event-stream" }), res);

    expect(res.headers["content-type"]).toContain("text/event-stream");
    // Proxy buffering would hold every chunk until the turn ends, defeating the point.
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(parseSseEvents(res.chunks)).toEqual([
      { event: "chunk", data: { text: "Lights are " } },
      { event: "chunk", data: { text: "on." } },
      {
        event: "done",
        data: {
          ok: true,
          response: "Lights are on.",
          continueConversation: false,
          traceId: "trace-2",
        },
      },
    ]);
    expect(res.writableEnded).toBe(true);
  });

  it("preserves continueConversation (S1.8) through the terminal event", async () => {
    generateMock.mockResolvedValue({
      text: "Which playlist?",
      continueConversation: true,
      traceId: "trace-3",
    });
    const res = createStreamingResponse();

    await createHandler()(createRequest({ accept: "text/event-stream" }), res);

    const done = parseSseEvents(res.chunks).at(-1);
    expect(done?.event).toBe("done");
    expect(done?.data.continueConversation).toBe(true);
  });

  it("reports a failed turn as a terminal error event, not an HTTP status", async () => {
    // The status code is committed to 200 when headers flush, before generation can fail.
    generateMock.mockResolvedValue({ text: null, error: "boom", traceId: "trace-4" });
    const res = createStreamingResponse();

    await createHandler()(createRequest({ accept: "text/event-stream" }), res);

    expect(res.statusCode).toBe(200);
    expect(parseSseEvents(res.chunks)).toEqual([
      { event: "error", data: { ok: false, error: "boom", traceId: "trace-4" } },
    ]);
    expect(res.writableEnded).toBe(true);
  });

  it("reports a turn that produced no speech as a silent success, not a failure", async () => {
    // SPOKEN_OUTPUT_CONTRACT lets the agent answer {"spoken":""} when there is nothing worth
    // saying. Observed live 2026-08-16: reporting that as ok:false made the satellite announce
    // "Sorry, I couldn't reach OpenClaw just now" for a turn that had reached the agent and run
    // to completion.
    generateMock.mockResolvedValue({
      text: null,
      continueConversation: false,
      traceId: "trace-silent",
    });
    const res = createStreamingResponse();

    await createHandler()(createRequest({ accept: "text/event-stream" }), res);

    const done = parseSseEvents(res.chunks).at(-1);
    expect(done?.event).toBe("done");
    expect(done?.data).toEqual({
      ok: true,
      response: "",
      continueConversation: false,
      traceId: "trace-silent",
    });
  });

  it("returns 200 with an empty response when a non-streaming turn produced no speech", async () => {
    generateMock.mockResolvedValue({ text: null, traceId: "trace-silent-2" });
    const res = createStreamingResponse();

    await createHandler()(createRequest({}), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.chunks.join(""))).toEqual({
      ok: true,
      response: "",
      continueConversation: false,
      traceId: "trace-silent-2",
    });
  });

  it("returns 502 with the error body when a non-streaming turn fails", async () => {
    generateMock.mockResolvedValue({ text: null, error: "boom", traceId: "trace-8" });
    const res = createStreamingResponse();

    await createHandler()(createRequest({}), res);

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.chunks.join(""))).toEqual({
      ok: false,
      error: "boom",
      traceId: "trace-8",
    });
  });

  it("ends the SSE stream with an error event when generation throws outright", async () => {
    // generateHaVoiceResponse resolves its own errors, but its prologue (agent-id/store-path
    // resolution) runs before that try block and can throw. Headers are already flushed by then,
    // so without a guard the client would hang with no terminal event and no ended response.
    generateMock.mockRejectedValue(new Error("prologue exploded"));
    const res = createStreamingResponse();

    await createHandler()(createRequest({ accept: "text/event-stream" }), res);

    const events = parseSseEvents(res.chunks);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("error");
    expect(String(events[0]?.data.error)).toContain("prologue exploded");
    expect(res.writableEnded).toBe(true);
  });

  it("forwards onSpokenReset as a reset event", async () => {
    generateMock.mockImplementation(async (args) => {
      args.onSpokenChunk?.("Let me check. ");
      args.onSpokenReset?.();
      args.onSpokenChunk?.("Lights are on.");
      return { text: "Lights are on.", continueConversation: false, traceId: "trace-5" };
    });
    const res = createStreamingResponse();

    await createHandler()(createRequest({ accept: "text/event-stream" }), res);

    expect(parseSseEvents(res.chunks).map((e) => e.event)).toEqual([
      "chunk",
      "reset",
      "chunk",
      "done",
    ]);
  });

  it("stops writing once the client disconnects mid-turn", async () => {
    const res = createStreamingResponse();
    generateMock.mockImplementation(async (args) => {
      args.onSpokenChunk?.("first");
      res.emit("close");
      args.onSpokenChunk?.("second");
      return { text: "first second", continueConversation: false, traceId: "trace-6" };
    });

    await createHandler()(createRequest({ accept: "text/event-stream" }), res);

    const events = parseSseEvents(res.chunks);
    expect(events).toEqual([{ event: "chunk", data: { text: "first" } }]);
  });

  it("keeps spoken text with newlines on a single SSE data line", async () => {
    generateMock.mockImplementation(async (args) => {
      args.onSpokenChunk?.("line one\nline two");
      return { text: "line one\nline two", continueConversation: false, traceId: "trace-7" };
    });
    const res = createStreamingResponse();

    await createHandler()(createRequest({ accept: "text/event-stream" }), res);

    // A raw newline in the payload would split the SSE record and corrupt the stream.
    const firstRecord = res.chunks.join("").split("\n\n")[0] ?? "";
    expect(firstRecord.split("\n").filter((l) => l.startsWith("data: "))).toHaveLength(1);
    expect(parseSseEvents(res.chunks)[0]?.data).toEqual({ text: "line one\nline two" });
  });
});
