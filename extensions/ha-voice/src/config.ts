// ha-voice config schema and resolution.
import { z } from "zod";
import { normalizeWebhookPath } from "../runtime-api.js";

const secretRefSchema = z
  .object({
    source: z.enum(["env", "file", "exec"]),
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
  })
  .strict();

const secretInputSchema = z.union([z.string().trim().min(1), secretRefSchema]);

export type HaVoiceSecretInput = z.infer<typeof secretInputSchema>;

const serveSchema = z
  .object({
    path: z.string().trim().min(1).optional(),
  })
  .strict();

export const haVoicePluginConfigSchema = z
  .object({
    agentId: z.string().trim().min(1).optional(),
    /**
     * "per-device" (default) keeps one persistent session per calling satellite (via the
     * request's `deviceId`), so MoaBot remembers the ongoing conversation with that device.
     * "shared" pools every device onto one session for a single-satellite home.
     */
    sessionScope: z.enum(["per-device", "shared"]).optional().default("per-device"),
    responseSystemPrompt: z.string().trim().min(1).optional(),
    responseTimeoutMs: z.number().int().positive().optional(),
    serve: serveSchema.optional().default({}),
    secret: secretInputSchema,
  })
  .strict();

export type HaVoicePluginConfig = z.infer<typeof haVoicePluginConfigSchema>;

const DEFAULT_PATH = "/plugins/ha-voice/converse";

export type ResolvedHaVoiceConfig = {
  path: string;
  agentId?: string;
  sessionScope: "per-device" | "shared";
  responseSystemPrompt?: string;
  responseTimeoutMs?: number;
  secret: HaVoiceSecretInput;
};

export function resolveHaVoicePluginConfig(params: {
  pluginConfig: unknown;
}): ResolvedHaVoiceConfig {
  const parsed = haVoicePluginConfigSchema.parse(params.pluginConfig ?? {});
  return {
    path: normalizeWebhookPath(parsed.serve.path ?? DEFAULT_PATH),
    ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
    sessionScope: parsed.sessionScope,
    ...(parsed.responseSystemPrompt ? { responseSystemPrompt: parsed.responseSystemPrompt } : {}),
    ...(parsed.responseTimeoutMs ? { responseTimeoutMs: parsed.responseTimeoutMs } : {}),
    secret: parsed.secret,
  };
}

/** One persistent session per calling device (or one shared session for the whole plugin). */
export function resolveHaVoiceSessionKey(params: {
  agentId: string;
  sessionScope: "per-device" | "shared";
  deviceId?: string;
}): string {
  const prefix = `agent:${params.agentId}:ha-voice`;
  if (params.sessionScope === "shared") {
    return prefix;
  }
  const device = params.deviceId?.trim() || "default";
  return `${prefix}:${device}`.toLowerCase();
}
