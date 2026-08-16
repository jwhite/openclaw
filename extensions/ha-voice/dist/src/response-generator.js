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
import { createIncrementalSpokenExtractor, extractSpokenTextFromPayloads, SPOKEN_OUTPUT_CONTRACT, SPOKEN_OUTPUT_RESPONSE_FORMAT, } from "./spoken-text.js";
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
export async function generateHaVoiceResponse(params) {
    const { coreConfig, agentRuntime, sessionKey, userMessage } = params;
    const agentId = normalizeAgentId(params.agentId);
    const cfg = coreConfig;
    const storePath = agentRuntime.session.resolveStorePath(cfg.session?.store, { agentId });
    const tCallStart = Date.now();
    try {
        return await agentRuntime.session.runWithWorkAdmission({ storePath, sessionKey }, async (abortSignal) => {
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
                        update: (entry) => entry.sessionId
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
            const basePrompt = params.responseSystemPrompt ??
                `You are ${agentName}, answering through a Home Assistant voice satellite. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. You have access to tools - use them when helpful.`;
            const extraSystemPrompt = `${basePrompt}\n\n${SPOKEN_OUTPUT_CONTRACT}`;
            const timeoutMs = params.responseTimeoutMs ?? agentRuntime.resolveAgentTimeoutMs({ cfg });
            // S2.4 follow-up (2026-08-08): the ~1.9s pre-model window measured via HA's intent-start
            // to openclaw's [model-fetch] start included this plugin's own prep work with no internal
            // breakdown. Logged unconditionally (cheap: one line, plain arithmetic) rather than gated
            // behind a log-level check, since the whole point is not needing a redeploy/trace-level
            // toggle to see it next time.
            console.error(`[ha-voice] setup stages: runId=${runId} lane-admission=${tAdmitted - tCallStart}ms ` +
                `workspace-ensure=${tWorkspaceReady - tAdmitted}ms session-resolve=${tSessionReady - tWorkspaceReady}ms ` +
                `identity-prompt=${Date.now() - tSessionReady}ms preModelTotal=${Date.now() - tCallStart}ms`);
            // S5.1: streams the answer as it generates, decoded incrementally because the raw stream
            // is JSON-wrapped (SPOKEN_OUTPUT_RESPONSE_FORMAT), not plain text. Reads the assistant
            // stream's *cumulative* text rather than onBlockReply: block-reply chunks are a lossy
            // partition (the chunker drops the whitespace at each break, so rejoining them welds
            // words together and TTS speaks invented words) — see createIncrementalSpokenExtractor.
            // onBlockReplyFlush still marks tool/rejected-retry boundaries, where the next text is a
            // new utterance rather than a continuation.
            let onAgentEvent;
            let onBlockReplyFlush;
            // Releases the extractor's held trailing partial word once the run can produce no more
            // snapshots — without it the last word of a plain-text answer is never spoken.
            let flushSpokenTail;
            if (params.onSpokenChunk) {
                const onSpokenChunk = params.onSpokenChunk;
                let spokenExtractor = createIncrementalSpokenExtractor();
                // A caller's callback throwing (e.g. a closed socket once S5.2 wires real delivery)
                // must not abort the whole agent run over a streaming-delivery failure — the batch
                // result.text path below still succeeds independently of this.
                const deliver = (delta) => {
                    if (!delta) {
                        return;
                    }
                    try {
                        onSpokenChunk(delta);
                    }
                    catch (err) {
                        console.error(`[ha-voice] onSpokenChunk threw, continuing without streaming: ${err}`);
                    }
                };
                flushSpokenTail = () => deliver(spokenExtractor.flush());
                onAgentEvent = (evt) => {
                    if (evt.stream !== "assistant") {
                        return;
                    }
                    const data = evt.data;
                    // "commentary" is pre-tool narration ("I'll check that...") - a display lane, never
                    // part of the spoken answer.
                    if (data.phase === "commentary") {
                        return;
                    }
                    if (typeof data.text !== "string" || data.text.length === 0) {
                        return;
                    }
                    deliver(spokenExtractor.pushSnapshot(data.text));
                };
                onBlockReplyFlush = (context) => {
                    if (context.reason === "pre_compaction" && context.attemptAccepted) {
                        // An accepted attempt's answer continues uninterrupted - only a rejected one is
                        // discarded and retried, which is what actually invalidates the buffer.
                        return;
                    }
                    if (context.reason !== "tool_start" && context.reason !== "pre_compaction") {
                        return;
                    }
                    // Both boundaries can be followed by a differently-shaped attempt (post-tool answer,
                    // or a compaction retry) - start clean so the two never mix in one JSON buffer.
                    // Whatever already streamed via onSpokenChunk can't be un-sent (same as TTS audio
                    // already playing can't be un-spoken), so the consumer needs its own signal that
                    // what follows is a fresh, disconnected utterance, not a continuation.
                    // Release the held partial word first, so the abandoned fragment ends on a whole word.
                    deliver(spokenExtractor.flush());
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
                // Deliberately no blockReplyChunking/blockReplyBreak: streaming reads the assistant
                // stream's cumulative text, so the block chunker is neither used nor paid for here.
                onAgentEvent,
                onBlockReplyFlush,
            });
            // No further snapshots can arrive, so the extractor's held final word is safe to speak.
            flushSpokenTail?.();
            const extracted = extractSpokenTextFromPayloads((result.payloads ?? []));
            if (!extracted.text && result.meta?.aborted) {
                return { text: null, error: "Response generation was aborted", traceId: runId };
            }
            return {
                text: extracted.text,
                continueConversation: extracted.continueConversation,
                traceId: runId,
            };
        });
    }
    catch (err) {
        return { text: null, error: String(err) };
    }
}
