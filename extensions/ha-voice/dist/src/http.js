import { z } from "zod";
import { createFixedWindowRateLimiter, createWebhookInFlightLimiter, normalizeLowercaseStringOrEmpty, readJsonWebhookBodyOrReject, resolveConfiguredSecretInputString, resolveRequestClientIp, resolveWebhookTargetWithAuthOrReject, safeEqualSecret, withResolvedWebhookRequestPipeline, WEBHOOK_IN_FLIGHT_DEFAULTS, WEBHOOK_RATE_LIMIT_DEFAULTS, } from "../api.js";
import { resolveHaVoiceSessionKey } from "./config.js";
import { generateHaVoiceResponse } from "./response-generator.js";
const converseRequestSchema = z
    .object({
    text: z.string().trim().min(1),
    /** Identifies the calling satellite so per-device conversation memory stays separate. */
    deviceId: z.string().trim().min(1).optional(),
})
    .strict();
function writeJson(res, statusCode, body) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
}
/** Single source of truth for the turn's terminal payload, so the streaming terminal event and
 * the non-streaming JSON body can never drift apart on shape or semantics (S5.2). */
function buildConverseOutcome(result) {
    return result.text
        ? {
            ok: true,
            response: result.text,
            continueConversation: result.continueConversation === true,
            traceId: result.traceId,
        }
        : { ok: false, error: result.error ?? "No response generated", traceId: result.traceId };
}
/** S5.2: opt-in via standard SSE content negotiation, so existing non-streaming callers keep
 * their current request shape and response body untouched. */
function acceptsEventStream(req) {
    const accept = Array.isArray(req.headers.accept)
        ? req.headers.accept.join(",")
        : (req.headers.accept ?? "");
    return normalizeLowercaseStringOrEmpty(accept).includes("text/event-stream");
}
function createSseWriter(req, res) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // This gateway sits behind a reverse proxy (gateway.trustedProxies); proxy response buffering
    // would hold chunks until the turn ends, defeating the entire point of streaming.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    let clientGone = false;
    const markGone = () => {
        clientGone = true;
    };
    req.on("aborted", markGone);
    res.on("close", markGone);
    return (event, data) => {
        if (clientGone || res.writableEnded) {
            return;
        }
        try {
            // JSON.stringify keeps the payload on one line, so an embedded newline in spoken text
            // can't be misread as an SSE record separator.
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        catch {
            // A write failure means the peer is gone; stop emitting rather than fail the turn, which
            // still completes and is reported through the non-streamed result.
            clientGone = true;
        }
    };
}
function extractSharedSecret(req) {
    const authHeader = Array.isArray(req.headers.authorization)
        ? (req.headers.authorization[0] ?? "")
        : (req.headers.authorization ?? "");
    if (normalizeLowercaseStringOrEmpty(authHeader).startsWith("bearer ")) {
        return authHeader.slice("bearer ".length).trim();
    }
    const sharedHeader = req.headers["x-openclaw-ha-voice-secret"];
    return Array.isArray(sharedHeader) ? (sharedHeader[0] ?? "").trim() : (sharedHeader ?? "").trim();
}
function formatZodError(error) {
    const firstIssue = error.issues[0];
    if (!firstIssue) {
        return "invalid request";
    }
    const path = firstIssue.path.length > 0 ? `${firstIssue.path.join(".")}: ` : "";
    return `${path}${firstIssue.message}`;
}
export function createHaVoiceWebhookRequestHandler(params) {
    const rateLimiter = createFixedWindowRateLimiter({
        windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
        maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
        maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
    });
    const inFlightLimiter = params.inFlightLimiter ??
        createWebhookInFlightLimiter({
            maxInFlightPerKey: WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey,
            maxTrackedKeys: WEBHOOK_IN_FLIGHT_DEFAULTS.maxTrackedKeys,
        });
    const resolveTargetSecret = async (target) => {
        if (typeof target.secretInput === "string") {
            return target.secretInput;
        }
        const resolved = await resolveConfiguredSecretInputString({
            config: params.cfg,
            env: process.env,
            value: target.secretInput,
            path: target.secretConfigPath,
        });
        return resolved.value;
    };
    return async (req, res) => {
        return await withResolvedWebhookRequestPipeline({
            req,
            res,
            targetsByPath: params.targetsByPath,
            allowMethods: ["POST"],
            requireJsonContentType: true,
            rateLimiter,
            rateLimitKey: (() => {
                const clientIp = resolveRequestClientIp(req, params.cfg.gateway?.trustedProxies, params.cfg.gateway?.allowRealIpFallback === true) ??
                    req.socket.remoteAddress ??
                    "unknown";
                return `${new URL(req.url ?? "/", "http://localhost").pathname}:${clientIp}`;
            })(),
            inFlightLimiter,
            handle: async ({ targets }) => {
                const presentedSecret = extractSharedSecret(req);
                const target = await resolveWebhookTargetWithAuthOrReject({
                    targets,
                    res,
                    isMatch: async (candidate) => {
                        if (presentedSecret.length === 0) {
                            return false;
                        }
                        const resolvedSecret = await resolveTargetSecret(candidate);
                        return Boolean(resolvedSecret && safeEqualSecret(resolvedSecret, presentedSecret));
                    },
                });
                if (!target) {
                    return true;
                }
                const body = await readJsonWebhookBodyOrReject({
                    req,
                    res,
                    maxBytes: 32 * 1024,
                    timeoutMs: 15_000,
                    emptyObjectOnEmpty: false,
                    invalidJsonMessage: "invalid request body",
                });
                if (!body.ok) {
                    return true;
                }
                const parsed = converseRequestSchema.safeParse(body.value);
                if (!parsed.success) {
                    writeJson(res, 400, { ok: false, error: formatZodError(parsed.error) });
                    return true;
                }
                const sessionKey = resolveHaVoiceSessionKey({
                    agentId: target.agentId,
                    sessionScope: target.sessionScope,
                    deviceId: parsed.data.deviceId,
                });
                const generateParams = {
                    coreConfig: params.cfg,
                    agentRuntime: target.agentRuntime,
                    sessionKey,
                    agentId: target.agentId,
                    responseSystemPrompt: target.responseSystemPrompt,
                    responseTimeoutMs: target.responseTimeoutMs,
                    userMessage: parsed.data.text,
                };
                if (acceptsEventStream(req)) {
                    // Headers must go out before generation starts, since the first chunk can arrive at
                    // any point after that - which also means the status code is committed to 200 up
                    // front, so a failed turn is reported by the terminal "error" event, not by status.
                    const sendEvent = createSseWriter(req, res);
                    try {
                        const streamed = await generateHaVoiceResponse({
                            ...generateParams,
                            onSpokenChunk: (chunk) => sendEvent("chunk", { text: chunk }),
                            // A tool call or rejected retry discards what was streamed so far; the consumer
                            // needs to know the next chunk starts a new utterance (see onSpokenReset's own doc).
                            onSpokenReset: () => sendEvent("reset", {}),
                        });
                        const outcome = buildConverseOutcome(streamed);
                        // The terminal event carries the full canonical text, not just the deltas: a consumer
                        // can prefer whichever it needs, and the two are allowed to differ slightly (the
                        // batch path applies trimming the incremental one deliberately cannot).
                        sendEvent(outcome.ok ? "done" : "error", outcome);
                    }
                    catch (err) {
                        // generateHaVoiceResponse resolves its own errors, but its prologue (agent-id and
                        // store-path resolution) runs before that try block and can still throw. Headers are
                        // already flushed by now, so the gateway's !headersSent 500 fallback cannot fire -
                        // without this the client would wait out its own timeout with no terminal event.
                        sendEvent("error", { ok: false, error: String(err) });
                    }
                    finally {
                        if (!res.writableEnded) {
                            res.end();
                        }
                    }
                    return true;
                }
                const result = await generateHaVoiceResponse(generateParams);
                const outcome = buildConverseOutcome(result);
                writeJson(res, outcome.ok ? 200 : 502, outcome);
                return true;
            },
        });
    };
}
