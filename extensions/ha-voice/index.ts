// ha-voice plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry, normalizeAgentId, type OpenClawPluginApi } from "./api.js";
import { resolveHaVoicePluginConfig } from "./src/config.js";
import { createHaVoiceWebhookRequestHandler, type HaVoiceWebhookTarget } from "./src/http.js";

function registerHaVoiceRoute(api: OpenClawPluginApi): void {
  const resolved = resolveHaVoicePluginConfig({ pluginConfig: api.pluginConfig });
  const agentId = normalizeAgentId(resolved.agentId);

  const targetsByPath = new Map<string, HaVoiceWebhookTarget[]>();
  const handler = createHaVoiceWebhookRequestHandler({
    cfg: api.config,
    targetsByPath,
  });

  const target: HaVoiceWebhookTarget = {
    path: resolved.path,
    secretInput: resolved.secret,
    secretConfigPath: "plugins.entries.ha-voice.config.secret",
    agentId,
    sessionScope: resolved.sessionScope,
    ...(resolved.responseSystemPrompt
      ? { responseSystemPrompt: resolved.responseSystemPrompt }
      : {}),
    ...(resolved.responseTimeoutMs ? { responseTimeoutMs: resolved.responseTimeoutMs } : {}),
    agentRuntime: api.runtime.agent,
  };
  targetsByPath.set(resolved.path, [target]);

  api.registerHttpRoute({
    path: resolved.path,
    auth: "plugin",
    match: "exact",
    replaceExisting: true,
    handler,
  });
  api.logger.info(`[ha-voice] registered converse route on ${resolved.path} for agent ${agentId}`);
}

export default definePluginEntry({
  id: "ha-voice",
  name: "Home Assistant Voice",
  description:
    "Authenticated webhook bridging a Home Assistant Assist pipeline to a real OpenClaw agent.",
  register(api: OpenClawPluginApi) {
    registerHaVoiceRoute(api);
  },
});
