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
import { createIncrementalSpokenExtractor, extractSpokenTextFromPayloads, SPOKEN_OUTPUT_CONTRACT, } from "./spoken-text.js";
/**
 * Voice turns are latency-sensitive in a way text chat isn't — a spoken exchange has a real
 * person waiting in a room. Time-to-first-token is the metric that matters, not total: spoken
 * text streams to TTS from the first chunk, so TTFT is what the listener actually waits through.
 *
 * Gemini was rejected here once, and that reasoning is now stale — recorded so it is not
 * re-applied. It originally failed with `FailoverError: provider rejected the request schema or
 * tool payload`, because Gemini is stricter about JSON Schema shapes (e.g. anyOf) than the
 * OpenAI-compatible providers and the voice path was still sending MoaBot's full 178-tool
 * catalog. RESPONSE_TOOLS_ALLOW cut that to 5 hand-written schemas, and Gemini accepts those.
 *
 * Measured 2026-08-19 against this prompt shape and those 5 tools, TTFT per call:
 *   gemini-3-flash-preview  1.11-1.55s, valid JSON contract, correct tool routing  <- chosen
 *   moonshotai/kimi-k2.5    2.23-5.50s (previous choice)
 *   inclusionai/ling-3.0-flash 0.75-0.86s and far cheaper, but a much smaller model;
 *     held in reserve if Gemini's latency stops being good enough for the quality it buys.
 *   amazon/nova-lite-v1     leaks <thinking> into spoken content — disqualified.
 *   qwen/qwen3.7-flash      produced no output at all — disqualified.
 *
 * A candidate has to clear three bars, not one: TTFT, emitting SPOKEN_OUTPUT_CONTRACT's JSON,
 * and routing to tools. Speed alone disqualifies nothing and qualifies nothing.
 */
const RESPONSE_PROVIDER = "openrouter";
const RESPONSE_MODEL = "google/gemini-3-flash-preview";
// S2.4 follow-up (2026-08-08): confirmed via trace-level `[trace:embedded-run] prep stages`
// logging that every ha-voice turn was building/sending MoaBot's full 178-tool catalog
// (core-plugin-tools + bundle-tools alone cost ~2.5s of the ~3.15s prep window). A voice
// satellite turn only ever needs ha-control's tools plus web search — bare names confirmed
// live (ha-control registers tools directly via api.registerTool, no plugin-id prefix; that
// prefix pattern only applies to MCP-bridged tools like affine__*).
const RESPONSE_TOOLS_ALLOW = [
    "web_search",
    "play_music_on_satellite",
    "control_satellite_playback",
    "set_satellite_volume",
    "set_sleep_timer",
    // Added 2026-09-21. Omitting it silently broke "start my day": the tool exists and is
    // registered, and MoaBot picks it correctly through the CLI where every tool is offered — but
    // this allowlist is what a *voice* turn actually sees, so through the satellite the tool did not
    // exist at all. The model then did the closest thing it could with what it had: started a
    // podcast with play_music_on_satellite and spoke the weather over the top of it. Instructions in
    // AGENTS.md cannot fix that; an allowlist is not a preference.
    // Anything the voice path is meant to be able to do must be listed here.
    "start_my_day",
    // Added 2026-09-25. Asked the time at 07:07 NZST, voice answered "It's 7:07 PM" — the model
    // was inventing it. The system prompt's Temporal Context gives only `Current date` and
    // `Time zone`, and then says "For the exact current time, use `session_status`" — a tool this
    // allowlist did not offer. Same class of failure as start_my_day above: the instruction is
    // sound, the tool simply did not exist for a voice turn. session_status is a native tool, so
    // it carries none of the per-run MCP cost measured below.
    "session_status",
    // Measured 2026-09-21, this same endpoint, one sample each — DO NOT add MCP-bridged tools here:
    //   6 tools, no MCP:      cold 8.07s, warm 4.51s / 4.39s
    //   + mempalace_search:   cold 13.19s, warm 6.17s / 5.43s   (+1.0-1.8s on EVERY warm turn,
    //                         even when the model never calls it)
    //   turns that used it:   10.19s then 8.87s — the second did not amortize, so the MCP runtime
    //                         cost is per RUN, not per session. Raising mcp.sessionIdleTtlMs does
    //                         not help: it only controls idle eviction, and cannot extend a
    //                         run-owned runtime past run end.
    // Memory in voice should go through a native tool that calls mempalace over HTTP instead.
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
            // Added 2026-09-25. Core's Temporal Context gives this agent only `Current date` and
            // `Time zone`, then defers the exact time to `session_status`. The chat path calls that
            // tool and answers correctly; this fast voice model does not — it reads the nearest ISO
            // timestamp in context instead, which is UTC. NZ is exactly UTC+12, so 22:01Z was spoken
            // as "10:01 PM" at 10:01 AM: the digits look right and only the meridiem is wrong, which
            // reads like a formatting slip and is not one. Adding session_status to the allowlist was
            // not enough — the tool has to be *called*. Stating local time outright leaves nothing to
            // misread. Safe to vary per turn: this provider/model reports cacheRead/cacheWrite 0, so
            // there is no prompt-cache prefix to invalidate.
            const userTimezone = cfg.agents?.defaults?.userTimezone?.trim() || undefined;
            const nowLine = `Current local time: ${new Intl.DateTimeFormat("en-NZ", {
                ...(userTimezone ? { timeZone: userTimezone } : {}),
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
            }).format(new Date())}${userTimezone ? ` (${userTimezone})` : ""}. ` +
                `Use this when asked the date or time. Do not infer either from any timestamp in context — those are UTC.`;
            const extraSystemPrompt = `${basePrompt}\n\n${nowLine}\n\n${SPOKEN_OUTPUT_CONTRACT}`;
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
            // is JSON-wrapped (SPOKEN_OUTPUT_CONTRACT), not plain text. Reads the assistant
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
                // Deliberately no responseFormat. Forcing the spoken contract as a strict
                // json_schema suppresses tool calls on this provider/model: measured 2026-08-16 over
                // 10 identical "Play Elvis Presley" turns, the model invoked play_music_on_satellite
                // 1/10 with the format on and 10/10 with it off — and in the 9 failures it still
                // claimed the music was playing, so the user heard a confirmation and silence.
                // Prompt instruction alone holds the JSON contract for 7/8 varied turns, and
                // extractSpokenTextFromPayloads' plain-text fallback already covers the rest, which
                // is a far cheaper failure than an assistant that lies about acting.
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
