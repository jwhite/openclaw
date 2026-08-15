// ha-voice tests cover response generator streaming behavior (S5.1).
import { describe, expect, it, vi } from "vitest";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { generateHaVoiceResponse } from "./response-generator.js";

type TestSessionEntry = { sessionId: string; updatedAt: number };

type EmbeddedAgentArgs = {
  extraSystemPrompt: string;
  onBlockReply?: (
    payload: { text?: string; isReasoning?: boolean; isCommentary?: boolean },
    context?: { assistantMessageIndex?: number },
  ) => void;
  onBlockReplyFlush?: (
    context:
      | { reason: "message_end" | "terminal" }
      | { reason: "tool_start"; assistantMessageIndex: number }
      | { reason: "pre_compaction"; attemptAccepted: boolean },
  ) => void | Promise<void>;
};

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
  const { runtime, runEmbeddedAgent } = createAgentRuntime(payloads, overrides?.runEmbeddedAgentImpl);
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
  it("does not pass onBlockReply/blockReplyChunking when the caller has no onSpokenChunk", async () => {
    const { runEmbeddedAgent } = await runGenerateHaVoiceResponse([
      { text: '{"spoken":"Done.","continueConversation":false}' },
    ]);
    const args = runEmbeddedAgent.mock.calls[0]?.[0] as EmbeddedAgentArgs & {
      blockReplyChunking?: unknown;
    };
    expect(args.onBlockReply).toBeUndefined();
    expect(args.blockReplyChunking).toBeUndefined();
  });

  it("streams decoded deltas via onSpokenChunk as onBlockReply fires", async () => {
    const chunks: string[] = [];
    const { result } = await runGenerateHaVoiceResponse(
      [{ text: '{"spoken":"Turning off the bedroom lights.","continueConversation":false}' }],
      {
        onSpokenChunk: (chunk) => chunks.push(chunk),
        runEmbeddedAgentImpl: async (args) => {
          args.onBlockReply?.({ text: '{"spoken":"Turning off ' }, { assistantMessageIndex: 0 });
          args.onBlockReply?.({ text: 'the bedroom lights.","continueConversation":false}' }, { assistantMessageIndex: 0 });
          return { payloads: [{ text: '{"spoken":"Turning off the bedroom lights.","continueConversation":false}' }] };
        },
      },
    );
    expect(chunks.join("")).toBe("Turning off the bedroom lights.");
    // The final non-streamed return value is unaffected by streaming having happened.
    expect(result.text).toBe("Turning off the bedroom lights.");
  });

  it("does not stream tool-progress/commentary/reasoning blocks", async () => {
    const chunks: string[] = [];
    await runGenerateHaVoiceResponse([{ text: '{"spoken":"Done.","continueConversation":false}' }], {
      onSpokenChunk: (chunk) => chunks.push(chunk),
      runEmbeddedAgentImpl: async (args) => {
        args.onBlockReply?.({ text: "checking the weather...", isCommentary: true }, { assistantMessageIndex: 0 });
        args.onBlockReply?.({ text: "internal reasoning", isReasoning: true }, { assistantMessageIndex: 0 });
        args.onBlockReply?.({ text: '{"spoken":"Done.","continueConversation":false}' }, { assistantMessageIndex: 0 });
        return { payloads: [{ text: '{"spoken":"Done.","continueConversation":false}' }] };
      },
    });
    expect(chunks.join("")).toBe("Done.");
  });

  it("discards pre-tool narration once a tool_start boundary fires", async () => {
    // A tool-boundary reset only stops pre-tool and post-tool content from mixing into one JSON
    // buffer going forward - it can't retroactively un-send a delta already streamed out via
    // onSpokenChunk before the boundary was known, the same way TTS can't un-speak audio already
    // playing. Both pieces are therefore expected in the final stream, not just the post-tool one.
    const chunks: string[] = [];
    await runGenerateHaVoiceResponse([{ text: '{"spoken":"Lights are on.","continueConversation":false}' }], {
      onSpokenChunk: (chunk) => chunks.push(chunk),
      runEmbeddedAgentImpl: async (args) => {
        // Pre-tool narration a model sometimes emits before deciding to call a tool.
        args.onBlockReply?.({ text: '{"spoken":"Let me check. ' }, { assistantMessageIndex: 0 });
        await args.onBlockReplyFlush?.({ reason: "tool_start", assistantMessageIndex: 0 });
        args.onBlockReply?.({ text: '{"spoken":"Lights are on.","continueConversation":false}' }, { assistantMessageIndex: 1 });
        return { payloads: [{ text: '{"spoken":"Lights are on.","continueConversation":false}' }] };
      },
    });
    expect(chunks.join("")).toBe("Let me check. Lights are on.");
  });

  it("rejects a stale chunk that arrives after the tool boundary with an old message index", async () => {
    // assistantMessageIndex on the tool_start boundary is the pre-tool message's own index;
    // legitimate new content after the boundary carries a strictly higher index (matching
    // extensions/voice-call's own convention) - only a chunk at or below the boundary index
    // (a deferred delivery from the superseded pre-tool attempt) should be rejected.
    const chunks: string[] = [];
    await runGenerateHaVoiceResponse([{ text: '{"spoken":"Lights are on.","continueConversation":false}' }], {
      onSpokenChunk: (chunk) => chunks.push(chunk),
      runEmbeddedAgentImpl: async (args) => {
        await args.onBlockReplyFlush?.({ reason: "tool_start", assistantMessageIndex: 0 });
        // A deferred delivery from the pre-boundary attempt, arriving late.
        args.onBlockReply?.({ text: '{"spoken":"stale' }, { assistantMessageIndex: 0 });
        args.onBlockReply?.({ text: '{"spoken":"Lights are on.","continueConversation":false}' }, { assistantMessageIndex: 1 });
        return { payloads: [{ text: '{"spoken":"Lights are on.","continueConversation":false}' }] };
      },
    });
    expect(chunks.join("")).toBe("Lights are on.");
  });

  it("resets the buffer on a pre_compaction retry so a rejected attempt's stale JSON never corrupts the accepted one", async () => {
    // Same "can't un-send already-streamed audio" characteristic as the tool_start case above:
    // "Five min" from the rejected attempt has already gone out via onSpokenChunk by the time the
    // reset fires. What the reset actually guarantees is decode correctness for what follows -
    // without it, the retry's chunks would append onto the stale buffer and could corrupt the
    // extraction (mixing two different "spoken" values); this proves the retry decodes clean.
    const chunks: string[] = [];
    await runGenerateHaVoiceResponse([{ text: '{"spoken":"Ten minutes.","continueConversation":false}' }], {
      onSpokenChunk: (chunk) => chunks.push(chunk),
      runEmbeddedAgentImpl: async (args) => {
        // A first attempt streams partial JSON, then gets rejected and retried.
        args.onBlockReply?.({ text: '{"spoken":"Five min' }, { assistantMessageIndex: 0 });
        await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: false });
        args.onBlockReply?.({ text: '{"spoken":"Ten minutes.","continueConversation":false}' }, { assistantMessageIndex: 0 });
        return { payloads: [{ text: '{"spoken":"Ten minutes.","continueConversation":false}' }] };
      },
    });
    expect(chunks.join("")).toBe("Five minTen minutes.");
  });

  it("fires onSpokenReset at a tool_start boundary so a consumer knows a fresh utterance is starting", async () => {
    const resets: number[] = [];
    await runGenerateHaVoiceResponse([{ text: '{"spoken":"Lights are on.","continueConversation":false}' }], {
      onSpokenChunk: () => {},
      onSpokenReset: () => resets.push(1),
      runEmbeddedAgentImpl: async (args) => {
        await args.onBlockReplyFlush?.({ reason: "tool_start", assistantMessageIndex: 0 });
        return { payloads: [{ text: '{"spoken":"Lights are on.","continueConversation":false}' }] };
      },
    });
    expect(resets.length).toBe(1);
  });

  it("fires onSpokenReset at a pre_compaction boundary for a REJECTED attempt", async () => {
    const resets: number[] = [];
    await runGenerateHaVoiceResponse([{ text: '{"spoken":"Ten minutes.","continueConversation":false}' }], {
      onSpokenChunk: () => {},
      onSpokenReset: () => resets.push(1),
      runEmbeddedAgentImpl: async (args) => {
        await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: false });
        return { payloads: [{ text: '{"spoken":"Ten minutes.","continueConversation":false}' }] };
      },
    });
    expect(resets.length).toBe(1);
  });

  it("does NOT reset at a pre_compaction boundary when the attempt was accepted", async () => {
    // An accepted attempt's answer is still continuing - resetting here would tell the consumer
    // to break mid-sentence for a compaction that didn't discard anything.
    const resets: number[] = [];
    const chunks: string[] = [];
    await runGenerateHaVoiceResponse([{ text: '{"spoken":"Here are the conditions: mild and clear.","continueConversation":false}' }], {
      onSpokenChunk: (chunk) => chunks.push(chunk),
      onSpokenReset: () => resets.push(1),
      runEmbeddedAgentImpl: async (args) => {
        args.onBlockReply?.({ text: '{"spoken":"Here are the conditions: ' }, { assistantMessageIndex: 0 });
        await args.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted: true });
        args.onBlockReply?.({ text: 'mild and clear.","continueConversation":false}' }, { assistantMessageIndex: 0 });
        return { payloads: [{ text: '{"spoken":"Here are the conditions: mild and clear.","continueConversation":false}' }] };
      },
    });
    expect(resets.length).toBe(0);
    // The buffer survived, so the continuing sentence decoded as one uninterrupted whole.
    expect(chunks.join("")).toBe("Here are the conditions: mild and clear.");
  });

  it("does not fire onSpokenReset for message_end/terminal flushes", async () => {
    const resets: number[] = [];
    await runGenerateHaVoiceResponse([{ text: '{"spoken":"Done.","continueConversation":false}' }], {
      onSpokenChunk: () => {},
      onSpokenReset: () => resets.push(1),
      runEmbeddedAgentImpl: async (args) => {
        await args.onBlockReplyFlush?.({ reason: "message_end" });
        return { payloads: [{ text: '{"spoken":"Done.","continueConversation":false}' }] };
      },
    });
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
          args.onBlockReply?.(
            { text: '{"spoken":"Lights are on.","continueConversation":false}' },
            { assistantMessageIndex: 0 },
          );
          return { payloads: [{ text: '{"spoken":"Lights are on.","continueConversation":false}' }] };
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
        args.onBlockReply?.({ text: "Sure, turning off " }, { assistantMessageIndex: 0 });
        args.onBlockReply?.({ text: "the lights now." }, { assistantMessageIndex: 0 });
        return { payloads: [{ text: "Sure, turning off the lights now." }] };
      },
    });
    expect(chunks.join("")).toBe("Sure, turning off the lights now.");
  });
});
