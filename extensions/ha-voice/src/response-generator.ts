/**
 * Runs a real OpenClaw agent turn for one Home Assistant Assist conversation exchange.
 *
 * Deliberately mirrors the voice-call plugin's `generateVoiceResponse` (same core
 * infrastructure: session store, workspace, runEmbeddedAgent) since a smart-speaker turn and a
 * phone-call turn have the same shape — get a real agent response for one line of transcribed
 * speech and hand back speakable text. Trimmed of phone-specific concerns (no transcript replay).
 * Callers that want the answer sentence-by-sentence as it generates pass onSpokenChunk (S5.1);
 * the returned result is identical either way.
 */
import crypto from "node:crypto";
import { normalizeAgentId } from "../api.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import {
  createIncrementalSpokenExtractor,
  extractSpokenTextFromPayloads,
  SPOKEN_OUTPUT_CONTRACT,
  SPOKEN_OUTPUT_RESPONSE_FORMAT,
  type SpokenPayload,
} from "./spoken-text.js";

export type HaVoiceResponseParams = {
  coreConfig: CoreConfig;
  agentRuntime: CoreAgentDeps;
  sessionKey: string;
  agentId?: string;
  responseSystemPrompt?: string;
  responseTimeoutMs?: number;
  /** The transcribed speech for this turn. */
  userMessage: string;
  /** S5.1: fires with each newly-decoded, sentence-sized speakable delta as it streams in.
   * Purely additive - the final return value is unaffected by whether a caller passes this. */
  onSpokenChunk?: (chunk: string) => void;
  /** S5.1: fires when a tool call or a rejected/retried attempt discards whatever was streamed
   * so far - chunks already delivered via onSpokenChunk can't be un-sent, but a consumer (S5.2+)
   * needs this to know the next onSpokenChunk starts a new, disconnected utterance rather than a
   * continuation, so it isn't glued onto prior audio with no pause/separator. */
  onSpokenReset?: () => void;
};

/**
 * Voice turns are latency-sensitive in a way text chat isn't — a spoken exchange has a real
 * person waiting in a room. Measured 2026-07-29: the inherited default (a large reasoning model)
 * took 16-21s per trivial turn, well past the sub-3-second target, partly from multiple
 * sequential provider round trips per turn. This model is already a configured fallback for the
 * default agent, so it's a known-good choice, not a new dependency.
 *
 * Not google/gemini-3-flash-preview: tried first, but Gemini's function-calling API rejected
 * MoaBot's full tool schema outright (`FailoverError: provider rejected the request schema or
 * tool payload`) — Gemini is stricter about JSON Schema shapes (e.g. anyOf) than the OpenAI-
 * compatible providers. kimi-k2.5 (Moonshot, OpenAI-compatible) accepts the same toolset fine.
 */
const RESPONSE_PROVIDER = "openrouter";
const RESPONSE_MODEL = "moonshotai/kimi-k2.5";

// S2.4 follow-up (2026-08-08): confirmed via trace-level `[trace:embedded-run] prep stages`
// logging that every ha-voice turn was building/sending MoaBot's full 178-tool catalog
// (core-plugin-tools + bundle-tools alone cost ~2.5s of the ~3.15s prep window). A voice
// satellite turn only ever needs ha-control's tools plus web search — bare names confirmed
// live (ha-control registers tools directly via api.registerTool, no plugin-id prefix; that
// prefix pattern only applies to MCP-bridged tools like affine__*).
const RESPONSE_TOOLS_ALLOW = [
  "web_search",
  "play_music_on_satellite",
  "set_satellite_volume",
  "set_sleep_timer",
];

export type HaVoiceResponseResult = {
  text: string | null;
  continueConversation?: boolean;
  error?: string;
  /** Reuses the same per-turn runId passed to runEmbeddedAgent (see S2.4) — lets the caller
   * correlate this response with openclaw's own detailed internal timing logs for the same
   * request, without inventing a second ID scheme. */
  traceId?: string;
};

export async function generateHaVoiceResponse(
  params: HaVoiceResponseParams,
): Promise<HaVoiceResponseResult> {
  const { coreConfig, agentRuntime, sessionKey, userMessage } = params;
  const agentId = normalizeAgentId(params.agentId);
  const cfg = coreConfig;

  const storePath = agentRuntime.session.resolveStorePath(cfg.session?.store, { agentId });
  const tCallStart = Date.now();

  try {
    return await agentRuntime.session.runWithWorkAdmission(
      { storePath, sessionKey },
      async (abortSignal) => {
        const tAdmitted = Date.now();
        const runId = `ha-voice:${sessionKey}:${tAdmitted}`;

        const agentDir = agentRuntime.resolveAgentDir(cfg, agentId);
        const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, agentId);
        await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });
        const tWorkspaceReady = Date.now();

        const now = Date.now();
        const existingSessionEntry = agentRuntime.session.getSessionEntry({
          storePath,
          sessionKey,
        });
        let sessionEntry = existingSessionEntry;
        if (!sessionEntry?.sessionId) {
          sessionEntry =
            (await agentRuntime.session.patchSessionEntry({
              storePath,
              sessionKey,
              fallbackEntry: { sessionId: crypto.randomUUID(), updatedAt: now },
              update: (entry) =>
                entry.sessionId
                  ? entry
                  : { ...entry, sessionId: crypto.randomUUID(), updatedAt: now },
            })) ?? undefined;
        }
        if (!sessionEntry?.sessionId) {
          return { text: null, error: "ha-voice session could not be initialized" };
        }
        const sessionId = sessionEntry.sessionId;
        const tSessionReady = Date.now();

        // Thinking-level policy is keyed off the same provider/model this run will actually use
        // (the dedicated fast voice model below), not the agent's general-purpose default.
        const thinkLevel = agentRuntime.resolveThinkingDefault({
          cfg,
          provider: RESPONSE_PROVIDER,
          model: RESPONSE_MODEL,
        });
        const identity = agentRuntime.resolveAgentIdentity(cfg, agentId);
        const agentName = identity?.name?.trim() || "assistant";

        const basePrompt =
          params.responseSystemPrompt ??
          `You are ${agentName}, answering through a Home Assistant voice satellite. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. You have access to tools - use them when helpful.`;
        const extraSystemPrompt = `${basePrompt}\n\n${SPOKEN_OUTPUT_CONTRACT}`;

        const timeoutMs = params.responseTimeoutMs ?? agentRuntime.resolveAgentTimeoutMs({ cfg });

        // S2.4 follow-up (2026-08-08): the ~1.9s pre-model window measured via HA's intent-start
        // to openclaw's [model-fetch] start included this plugin's own prep work with no internal
        // breakdown. Logged unconditionally (cheap: one line, plain arithmetic) rather than gated
        // behind a log-level check, since the whole point is not needing a redeploy/trace-level
        // toggle to see it next time.
        console.error(
          `[ha-voice] setup stages: runId=${runId} lane-admission=${tAdmitted - tCallStart}ms ` +
            `workspace-ensure=${tWorkspaceReady - tAdmitted}ms session-resolve=${tSessionReady - tWorkspaceReady}ms ` +
            `identity-prompt=${Date.now() - tSessionReady}ms preModelTotal=${Date.now() - tCallStart}ms`,
        );

        // S5.1: streams the spoken-JSON answer sentence-by-sentence via the same block-reply
        // machinery channel previews use (docs/concepts/streaming.md), decoded incrementally
        // since the raw stream is JSON-wrapped (SPOKEN_OUTPUT_RESPONSE_FORMAT), not plain text.
        // onBlockReplyFlush mirrors extensions/voice-call's own pattern for the same hazard: a
        // tool call or a rejected/retried attempt can leave stale chunks arriving after a
        // boundary, so every reset here starts a fresh extractor and rejects anything at or
        // before the last known tool boundary.
        let onBlockReply:
          | ((
              payload: { text?: string; isReasoning?: boolean; isCommentary?: boolean },
              context?: { assistantMessageIndex?: number },
            ) => void)
          | undefined;
        let onBlockReplyFlush:
          | ((context: {
              reason: string;
              assistantMessageIndex?: number;
              attemptAccepted?: boolean;
            }) => void)
          | undefined;
        if (params.onSpokenChunk) {
          const onSpokenChunk = params.onSpokenChunk;
          let spokenExtractor = createIncrementalSpokenExtractor();
          let latestToolBoundaryMessageIndex: number | undefined;
          onBlockReply = (payload, context) => {
            if (latestToolBoundaryMessageIndex !== undefined) {
              const messageIndex = context?.assistantMessageIndex;
              if (messageIndex === undefined || messageIndex <= latestToolBoundaryMessageIndex) {
                return;
              }
            }
            // Tool-progress/commentary/reasoning is never part of the final spoken-JSON answer.
            if (payload.isReasoning || payload.isCommentary || !payload.text) {
              return;
            }
            const delta = spokenExtractor.push(payload.text);
            if (!delta) {
              return;
            }
            try {
              // A caller's callback throwing (e.g. a closed socket once S5.2 wires real
              // delivery) must not abort the whole agent run over a streaming-delivery failure
              // — the batch result.text path below still succeeds independently of this.
              onSpokenChunk(delta);
            } catch (err) {
              console.error(`[ha-voice] onSpokenChunk threw, continuing without streaming: ${err}`);
            }
          };
          onBlockReplyFlush = (context) => {
            if (context.reason === "tool_start") {
              latestToolBoundaryMessageIndex = context.assistantMessageIndex;
            } else if (context.reason === "pre_compaction") {
              // An accepted attempt's answer continues uninterrupted - only a rejected one is
              // discarded and retried, which is what actually invalidates the buffer.
              if (context.attemptAccepted) {
                return;
              }
              latestToolBoundaryMessageIndex = undefined;
            } else {
              return;
            }
            // Both boundaries can be followed by a differently-shaped attempt (post-tool answer,
            // or a compaction retry) - start clean so the two never mix in one JSON buffer.
            // Whatever already streamed via onSpokenChunk can't be un-sent (same as TTS audio
            // already playing can't be un-spoken), so the consumer needs its own signal that
            // what follows is a fresh, disconnected utterance, not a continuation.
            spokenExtractor = createIncrementalSpokenExtractor();
            params.onSpokenReset?.();
          };
        }

        const result = await agentRuntime.runEmbeddedAgent({
          sessionId,
          sessionKey,
          sessionTarget: { agentId, sessionId, sessionKey, storePath },
          agentId,
          messageProvider: "ha-voice",
          workspaceDir,
          config: cfg,
          prompt: userMessage,
          provider: RESPONSE_PROVIDER,
          model: RESPONSE_MODEL,
          thinkLevel,
          verboseLevel: "off",
          timeoutMs,
          runId,
          // Keyed per session (per-device, when sessionScope is "per-device") rather than one
          // shared "ha-voice" string — a slow turn on one device must not queue/time out a turn
          // on another. Measured 2026-07-29: a shared lane produced real waits up to 38s.
          lane: `ha-voice:${sessionKey}`,
          extraSystemPrompt,
          agentDir,
          abortSignal,
          // Enforces the spoken-JSON contract at the API layer (see SPOKEN_OUTPUT_RESPONSE_FORMAT's
          // own comment) — prompt instruction alone was not reliable.
          streamParams: { responseFormat: SPOKEN_OUTPUT_RESPONSE_FORMAT },
          // See RESPONSE_TOOLS_ALLOW's own comment: cuts the model payload from 178 tool
          // schemas to 4, and skips bundle MCP/LSP runtime construction entirely (neither
          // runtime is needed for any of these tools). Does not shrink core-plugin-tools'
          // construction cost — that stage builds every installed plugin's tools as a single
          // all-or-nothing unit regardless of the allowlist content.
          toolsAllow: RESPONSE_TOOLS_ALLOW,
          onBlockReply,
          onBlockReplyFlush,
          // Gated on onSpokenChunk like onBlockReply above - unset today (S5.2 is the first real
          // caller), and an unused chunker still costs real per-token work on this latency-
          // sensitive path (see RESPONSE_TOOLS_ALLOW's own comment) if constructed regardless.
          ...(params.onSpokenChunk
            ? {
                // Sentence-sized, not paragraph-sized — the point is starting TTS sooner, and a
                // paragraph-sized chunk defeats that. text_end flushes as the chunker emits.
                blockReplyChunking: { minChars: 20, maxChars: 150, breakPreference: "sentence" as const },
                blockReplyBreak: "text_end" as const,
              }
            : {}),
        });

        const extracted = extractSpokenTextFromPayloads((result.payloads ?? []) as SpokenPayload[]);
        if (!extracted.text && result.meta?.aborted) {
          return { text: null, error: "Response generation was aborted", traceId: runId };
        }
        return {
          text: extracted.text,
          continueConversation: extracted.continueConversation,
          traceId: runId,
        };
      },
    );
  } catch (err) {
    return { text: null, error: String(err) };
  }
}
