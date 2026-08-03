// ha-control plugin entrypoint registers its OpenClaw integration.
import {
  definePluginEntry,
  resolveConfiguredSecretInputString,
  type OpenClawPluginApi,
} from "./api.js";
import { resolveHaControlPluginConfig, type ResolvedHaControlConfig } from "./src/config.js";
import { createPlayMusicTool } from "./src/play-music-tool.js";

// Unlike ha-events (a persistent WebSocket subscriber, guarded against opening a second
// connection), this plugin only registers a stateless tool descriptor — cheap and idempotent.
// register() has been observed firing more than once per process (each apparently building its
// own tool registry snapshot), so re-registering every time is required, not just tolerated: an
// ha-events-style "only run once" guard here silently drops the tool from every registry after
// the first, which is exactly the bug that shipped initially (tool visible in startup logs but
// missing from real agent turns).
async function registerHaControlTools(
  api: OpenClawPluginApi,
  resolved: ResolvedHaControlConfig,
): Promise<void> {
  const token =
    typeof resolved.token === "string"
      ? resolved.token
      : (
          await resolveConfiguredSecretInputString({
            config: api.config,
            env: process.env,
            value: resolved.token,
            path: "plugins.entries.ha-control.config.token",
          })
        ).value;

  if (!token) {
    api.logger.error("[ha-control] could not resolve HA token — tools will not be registered");
    return;
  }

  api.registerTool(
    createPlayMusicTool({
      baseUrl: resolved.baseUrl,
      token,
      defaultMediaPlayerEntityId: resolved.defaultMediaPlayerEntityId,
      musicAssistantConfigEntryId: resolved.musicAssistantConfigEntryId,
    }),
    { name: "play_music_on_satellite" },
  );

  api.logger.info(`[ha-control] registered play_music_on_satellite (target: ${resolved.baseUrl})`);
}

export default definePluginEntry({
  id: "ha-control",
  name: "Home Assistant Control",
  description:
    "Gives MoaBot a bounded set of Home Assistant service-call actions, starting with Music Assistant playback.",
  register(api: OpenClawPluginApi) {
    const resolved = resolveHaControlPluginConfig({ pluginConfig: api.pluginConfig });
    void registerHaControlTools(api, resolved);
  },
});
