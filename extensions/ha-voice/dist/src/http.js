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
                const result = await generateHaVoiceResponse({
                    coreConfig: params.cfg,
                    agentRuntime: target.agentRuntime,
                    sessionKey,
                    agentId: target.agentId,
                    responseSystemPrompt: target.responseSystemPrompt,
                    responseTimeoutMs: target.responseTimeoutMs,
                    userMessage: parsed.data.text,
                });
                if (!result.text) {
                    writeJson(res, 502, {
                        ok: false,
                        error: result.error ?? "No response generated",
                        traceId: result.traceId,
                    });
                    return true;
                }
                writeJson(res, 200, {
                    ok: true,
                    response: result.text,
                    continueConversation: result.continueConversation === true,
                    traceId: result.traceId,
                });
                return true;
            },
        });
    };
}
