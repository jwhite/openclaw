// ha-voice tests cover response generator streaming behavior (S5.1).
import { describe, expect, it, vi } from "vitest";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { generateHaVoiceResponse } from "./response-generator.js";

type TestSessionEntry = { sessionId: string; updatedAt: number };

type EmbeddedAgentArgs = {
  extraSystemPrompt: string;
  /** Mirrors the core assistant stream: `text` is the cumulative text so far, not a delta. */
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
  onBlockReplyFlush?: (
    context:
      | { reason: "message_end" | "terminal" }
      | { reason: "tool_start"; assistantMessageIndex: number }
      | { reason: "pre_compaction"; attemptAccepted: boolean },
  ) => void | Promise<void>;
};

/** Emits the assistant-stream events core would produce for a run whose cumulative text passes
 * through these snapshots (see buildAssistantStreamData in embedded-agent-subscribe.handlers). */
function emitAssistantSnapshots(args: EmbeddedAgentArgs, snapshots: string[]): void {
  for (const text of snapshots) {
    args.onAgentEvent?.({ stream: "assistant", data: { text, delta: "" } });
  }
}

/** Adapted from extensions/voice-call/src/response-generator.test.ts's own harness - both
 * plugins share the same core infrastructure by design (see response-generator.ts's top comment). */
function createAgentRuntime(
  payloads: Array<Record<string, unknown>>,
  runEmbeddedAgentImpl?: (args: EmbeddedAgentArgs) => Promise<{ payloads: unknown[] }>,
) {
  const sessionStore: Record<string, TestSessionEntry> = {};
  const runEmbeddedAgent = vi.fn(
    runEmbeddedAgentImpl ?? (async () => ({ payloads, meta: { aborted: false } })),
  );
  const runtime = {
    resolveAgentDir: () => "/tmp/openclaw/agents/main",
    resolveAgentWorkspaceDir: () => "/tmp/openclaw/workspace/main",
    resolveAgentIdentity: () => ({ name: "MoaBot" }),
    resolveThinkingDefault: () => "off",
    resolveAgentTimeoutMs: () => 30_000,
    ensureAgentWorkspace: async () => {},
    runEmbeddedAgent,
    session: {
      resolveStorePath: () => "/tmp/openclaw/main/sessions.json",
      getSessionEntry: (params: { sessionKey: string }) => sessionStore[params.sessionKey],
      patchSessionEntry: async (params: {
        sessionKey: string;
        fallbackEntry?: TestSessionEntry;
        update: (entry: TestSessionEntry) => TestSessionEntry;
      }) => {
        const existing = sessionStore[params.sessionKey] ?? params.fallbackEntry!;
        const next = params.update(existing);
        sessionStore[params.sessionKey] = next;
        return next;
      },
      runWithWorkAdmission: async (
        _params: { storePath: string; sessionKey: string },
        run: (signal: AbortSignal) => Promise<unknown>,
      ) => await run(new AbortController().signal),
    },
  } as unknown as CoreAgentDeps;

  return { runtime, runEmbeddedAgent };
}

async function runGenerateHaVoiceResponse(
  payloads: Array<Record<string, unknown>>,
  overrides?: {
    runEmbeddedAgentImpl?: (args: EmbeddedAgentArgs) => Promise<{ payloads: unknown[] }>;
    onSpokenChunk?: (chunk: string) => void;
    onSpokenReset?: () => void;
  },
) {
  const { runtime, runEmbeddedAgent } = createAgentRuntime(
    payloads,
    overrides?.runEmbeddedAgentImpl,
  );
  const coreConfig = {} as CoreConfig;

  const result = await generateHaVoiceResponse({
    coreConfig,
    agentRuntime: runtime,
    sessionKey: "device-123",
    userMessage: "turn on the lights",
    onSpokenChunk: overrides?.onSpokenChunk,
    onSpokenReset: overrides?.onSpokenReset,
  });

  return { result, runEmbeddedAgent };
}

describe("generateHaVoiceResponse streaming (S5.1)", () => {
  it("never asks core for block-reply chunking, whose partition is lossy for reassembly", async () => {
    const chunks: string[] = [];
    const { runEmbeddedAgent } = await runGenerateHaVoiceResponse(
      [{ text: '{"spoken":"Done.","continueConversation":false}' }],
      { onSpokenChunk: (chunk) => chunks.push(chunk) },
    );
    const args = runEmbeddedAgent.mock.calls[0]?.[0] as EmbeddedAgentArgs & {
      onBlockReply?: unknown;
      blockReplyChunking?: unknown;
      blockReplyBreak?: unknown;
    };
    expect(args.onBlockReply).toBeUndefined();
    expect(args.blockReplyChunking).toBeUndefined();
    expect(args.blockReplyBreak).toBeUndefined();
  });

  it("passes no streaming callbacks at all when the caller has no onSpokenChunk", async () => {
    const { runEmbeddedAgent } = await runGenerateHaVoiceResponse([
      { text: '{"spoken":"Done.","continueConversation":false}' },
    ]);
    const args = runEmbeddedAgent.mock.calls[0]?.[0] as EmbeddedAgentArgs;
    expect(args.onAgentEvent).toBeUndefined();
    expect(args.onBlockReplyFlush).toBeUndefined();
  });

  it("streams decoded deltas via onSpokenChunk as assistant snapshots arrive", async () => {
    const chunks: string[] = [];
    const { result } = await runGenerateHaVoiceResponse(
      [{ text: '{"spoken":"Turning off the bedroom lights.","continueConversation":false}' }],
      {
        onSpokenChunk: (chunk) => chunks.push(chunk),
        runEmbeddedAgentImpl: async (args) => {
          emitAssistantSnapshots(args, [
            '{"spoken":"Turning off ',
            '{"spoken":"Turning off the bedroom lights.","continueConversation":false}',
          ]);
          return {
            payloads: [
              { text: '{"spoken":"Turning off the bedroom lights.","continueConversation":false}' },
            ],
          };
        },
      },
    );
    expect(chunks.join("")).toBe("Turning off the bedroom lights.");
    // The final non-streamed return value is unaffected by streaming having happened.
    expect(result.text).toBe("Turning off the bedroom lights.");
  });

  it("streams text whose concatenation exactly reproduces the final answer", async () => {
    // Regression for the defect that made Kokoro speak invented words: deltas built from
    // onBlockReply chunks dropped the whitespace at every chunk break, so "The quick"+"brown fox"
    // rejoined as "quickbrown". The streamed audio and the returned text must not diverge.
    const chunks: string[] = [];
    const finalAnswer = "The quick brown fox jumps over the lazy dog near the river bank today.";
    const { result } = await runGenerateHaVoiceResponse(
      [{ text: `{"spoken":"${finalAnswer}","continueConversation":false}` }],
      {
        onSpokenChunk: (chunk) => chunks.push(chunk),
        runEmbeddedAgentImpl: async (args) => {
          emitAssistantSnapshots(args, [
            '{"spoken":"The quick',
            '{"spoken":"The quick brown fox jumps over',
            '{"spoken":"The quick brown fox jumps over the lazy dog near the river',
            `{"spoken":"${finalAnswer}","continueConversation":false}`,
          ]);
          return {
            payloads: [{ text: `{"spoken":"${finalAnswer}","continueConversation":false}` }],
          };
        },
      },
    );
    expect(chunks.join("")).toBe(finalAnswer);
    expect(chunks.join("")).toBe(result.text);
  });

  it("does not stream commentary-phase narration or non-assistant streams", async () => {
    const chunks: string[] = [];
    await runGenerateHaVoiceResponse(
      [{ text: '{"spoken":"Done.","continueConversation":false}' }],
      {
        onSpokenChunk: (chunk) => chunks.push(chunk),
        runEmbeddedAgentImpl: async (args) => {
          args.onAgentEvent?.({
            stream: "assistant",
            data: { text: "checking the weather...", phase: "commentary" },
          });
          args.onAgentEvent?.({ stream: "reasoning", data: { text: "internal reasoning" } });
          emitAssistantSnapshots(args, ['{"spoken":"Done.","continueConversation":false}']);
          return { payloads: [{ text: '{"spoken":"Done.","continueConversation":false}' }] };
        },
      },
    );
    expect(chunks.join("")).toBe("Done.");
  });

  it("discards pre-tool narration once a tool_start boundary fires", async () => {
    // A tool-boundary reset only stops pre-tool and post-tool content from mixing into one JSON
    // buffer going forward - it can't retroactively un-send a delta already streamed out via
    // onSpokenChunk before the boundary was known, the same way TTS can't un-speak audio already
    // playing. Both pieces are therefore expected in the final stream, not just the post-tool one.
    const chunks: string[] = [];
    await runGenerateHaVoiceResponse(
      [{ text: '{"spoken":"Lights are on.","continueConversation":false}' }],
      {
        onSpokenChunk: (chunk) => chunks.push(chunk),
        runEmbeddedAgentImpl: async (args) => {
          // Pre-tool narration a model sometimes emits before deciding to call a tool.
          emitAssistantSnapshots(args, ['{"spoken":"Let me check. ']);
          await args.onBlockReplyFlush?.({ reason: "tool_start", assistantMessageIndex: 0 });
          // The post-tool assistant message restarts core's cumulative text from empty.
          emitAssistantSnapshots(args, [
            '{"spoken":"Lights are on.","continueConversation":false}',
          ]);
          return {
            payloads: [{ text: '{"spoken":"Lights are on.","continueConversation":false}' }],
          };
        },
      },
    );
    expect(chunks.join("")).toBe("Let me check. Lights are on.");
  });

  it("replays nothing when a superseded attempt's snapshot arrives after the boundary", async () => {
    // Snapshots make stale-delivery rejection structural rather than an explicit index check: a
    // late snapshot from a superseded attempt simply doesn't extend what was already emitted, and
    // a divergent snapshot resyncs silently instead of re-speaking.
    const chunks: string[] = [];
    await runGenerateHaVoiceResponse(
      [{ text: '{"spoken":"Lights are on.","continueConversation":false}' }],
      {
        onSpokenChunk: (chunk) => chunks.push(chunk),
        runEmbeddedAgentImpl: async (args) => {
          emitAssistantSnapshots(args, [
            '{"spoken":"Lights are on.","continueConversation":false}',
          ]);
          // A deferred delivery from the superseded attempt, arriving late.
          emitAssistantSnapshots(args, ['{"spoken":"stale']);
          return {
            payloads: [{ text: '{"spoken":"Lights are on.","continueConversation":false}' }],
          };
        },
      },
    );
    expect(chunks.join("")).toBe("Lights are on.");
  });

  it("resets the buffer on a pre_compaction retry so a rejected attempt's stale JSON never corrupts the accepted one", async () => {
    // Same "can't un-send already-streamed audio" characteristic as the tool_start case above:
    // "Five min" from the rejected attempt has already gone out via onSpokenChunk by the time the
    // reset fires. What the reset actually guarantees is decode correctness for what follows -
    // without it, the retry's snapshot would look like a divergence and be swallowed entirely.
    const chunks: string[] = [];
    await runGenerateHaVoiceResponse(
      [{ text: '{"spoken":"Ten minutes.","continueConversation":false}' }],
      {
        onSpokenChunk: (chunk) => chunks.push(chunk),
        runEmbeddedAgentImpl: async (args) => {
          // A first attempt streams partial JSON, then gets rejected and retried.
          emitAssistantSnapshots(args, ['{"spoken":"Five min']);
          await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: false });
          emitAssistantSnapshots(args, ['{"spoken":"Ten minutes.","continueConversation":false}']);
          return { payloads: [{ text: '{"spoken":"Ten minutes.","continueConversation":false}' }] };
        },
      },
    );
    expect(chunks.join("")).toBe("Five minTen minutes.");
  });

  it("fires onSpokenReset at a tool_start boundary so a consumer knows a fresh utterance is starting", async () => {
    const resets: number[] = [];
    await runGenerateHaVoiceResponse(
      [{ text: '{"spoken":"Lights are on.","continueConversation":false}' }],
      {
        onSpokenChunk: () => {},
        onSpokenReset: () => resets.push(1),
        runEmbeddedAgentImpl: async (args) => {
          await args.onBlockReplyFlush?.({ reason: "tool_start", assistantMessageIndex: 0 });
          return {
            payloads: [{ text: '{"spoken":"Lights are on.","continueConversation":false}' }],
          };
        },
      },
    );
    expect(resets.length).toBe(1);
  });

  it("fires onSpokenReset at a pre_compaction boundary for a REJECTED attempt", async () => {
    const resets: number[] = [];
    await runGenerateHaVoiceResponse(
      [{ text: '{"spoken":"Ten minutes.","continueConversation":false}' }],
      {
        onSpokenChunk: () => {},
        onSpokenReset: () => resets.push(1),
        runEmbeddedAgentImpl: async (args) => {
          await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: false });
          return { payloads: [{ text: '{"spoken":"Ten minutes.","continueConversation":false}' }] };
        },
      },
    );
    expect(resets.length).toBe(1);
  });

  it("does NOT reset at a pre_compaction boundary when the attempt was accepted", async () => {
    // An accepted attempt's answer is still continuing - resetting here would tell the consumer
    // to break mid-sentence for a compaction that didn't discard anything.
    const resets: number[] = [];
    const chunks: string[] = [];
    const finalAnswer = "Here are the conditions: mild and clear.";
    await runGenerateHaVoiceResponse(
      [{ text: `{"spoken":"${finalAnswer}","continueConversation":false}` }],
      {
        onSpokenChunk: (chunk) => chunks.push(chunk),
        onSpokenReset: () => resets.push(1),
        runEmbeddedAgentImpl: async (args) => {
          emitAssistantSnapshots(args, ['{"spoken":"Here are the conditions: ']);
          await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
          emitAssistantSnapshots(args, [
            `{"spoken":"${finalAnswer}","continueConversation":false}`,
          ]);
          return {
            payloads: [{ text: `{"spoken":"${finalAnswer}","continueConversation":false}` }],
          };
        },
      },
    );
    expect(resets.length).toBe(0);
    // The buffer survived, so the continuing sentence decoded as one uninterrupted whole.
    expect(chunks.join("")).toBe(finalAnswer);
  });

  it("does not fire onSpokenReset for message_end/terminal flushes", async () => {
    const resets: number[] = [];
    await runGenerateHaVoiceResponse(
      [{ text: '{"spoken":"Done.","continueConversation":false}' }],
      {
        onSpokenChunk: () => {},
        onSpokenReset: () => resets.push(1),
        runEmbeddedAgentImpl: async (args) => {
          await args.onBlockReplyFlush?.({ reason: "message_end" });
          await args.onBlockReplyFlush?.({ reason: "terminal" });
          return { payloads: [{ text: '{"spoken":"Done.","continueConversation":false}' }] };
        },
      },
    );
    expect(resets.length).toBe(0);
  });

  it("does not let an onSpokenChunk callback exception abort the turn or the final result", async () => {
    const { result } = await runGenerateHaVoiceResponse(
      [{ text: '{"spoken":"Lights are on.","continueConversation":false}' }],
      {
        onSpokenChunk: () => {
          throw new Error("simulated closed socket");
        },
        runEmbeddedAgentImpl: async (args) => {
          emitAssistantSnapshots(args, [
            '{"spoken":"Lights are on.","continueConversation":false}',
          ]);
          return {
            payloads: [{ text: '{"spoken":"Lights are on.","continueConversation":false}' }],
          };
        },
      },
    );
    expect(result.text).toBe("Lights are on.");
  });

  it("streams plain-text fallback deltas when the model breaks the JSON contract entirely", async () => {
    // Real, measured failure mode (see spoken-text.ts's own comment): without the fallback this
    // model/provider streams nothing at all for roughly half of real turns.
    const chunks: string[] = [];
    await runGenerateHaVoiceResponse([{ text: "Sure, turning off the lights now." }], {
      onSpokenChunk: (chunk) => chunks.push(chunk),
      runEmbeddedAgentImpl: async (args) => {
        emitAssistantSnapshots(args, ["Sure, turning off ", "Sure, turning off the lights now."]);
        return { payloads: [{ text: "Sure, turning off the lights now." }] };
      },
    });
    expect(chunks.join("")).toBe("Sure, turning off the lights now.");
  });
});
