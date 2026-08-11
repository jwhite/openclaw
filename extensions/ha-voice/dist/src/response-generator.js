/**
 * Runs a real OpenClaw agent turn for one Home Assistant Assist conversation exchange.
 *
 * Deliberately mirrors the voice-call plugin's `generateVoiceResponse` (same core
 * infrastructure: session store, workspace, runEmbeddedAgent) since a smart-speaker turn and a
 * phone-call turn have the same shape — get a real agent response for one line of transcribed
 * speech and hand back speakable text. Trimmed of phone-specific concerns (no transcript replay,
 * no early/streamed delivery — HA waits for one full HTTP response per turn, so there is no need
 * to flush partial text early the way a live call does).
 */
import crypto from "node:crypto";
import { normalizeAgentId } from "../api.js";
import { extractSpokenTextFromPayloads, SPOKEN_OUTPUT_CONTRACT, SPOKEN_OUTPUT_RESPONSE_FORMAT, } from "./spoken-text.js";
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
            console.error(`[ha-voice] setup stages: runId=${runId} lane-admission=${tAdmitted - tCallStart}ms ` +
                `workspace-ensure=${tWorkspaceReady - tAdmitted}ms session-resolve=${tSessionReady - tWorkspaceReady}ms ` +
                `identity-prompt=${Date.now() - tSessionReady}ms preModelTotal=${Date.now() - tCallStart}ms`);
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
                streamParams: { responseFormat: SPOKEN_OUTPUT_RESPONSE_FORMAT },
                toolsAllow: RESPONSE_TOOLS_ALLOW,
            });
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
