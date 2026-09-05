// ha-control plugin entrypoint registers its OpenClaw integration.
import {
  definePluginEntry,
  resolveConfiguredSecretInputString,
  type OpenClawPluginApi,
} from "./api.js";
import { resolveHaControlPluginConfig, type ResolvedHaControlConfig } from "./src/config.js";
import { createPlayMusicTool } from "./src/play-music-tool.js";
import { createPlaybackControlTool } from "./src/playback-control-tool.js";
import { createSleepTimerTool } from "./src/sleep-timer-tool.js";
import { createVolumeTool } from "./src/volume-tool.js";

// `registerTool`'s factory contract (OpenClawPluginToolFactory) returns AnyAgentTool
// synchronously, not a Promise — the runtime builds a tool-registry snapshot immediately after
// register() returns, so any registration deferred past that point (e.g. the previous
// `void registerHaControlTools(...)` fire-and-forget pattern, copied from ha-events where it's
// fine because a WebSocket connection has no such deadline) is invisible to any snapshot taken
// before the deferred work finishes. Real bug hit live 2026-08-03: the tool appeared in startup
// logs (registration eventually completed) but was missing from real conversation turns whose
// snapshot got built first — intermittent, not deterministic, which is what made it easy to miss
// in testing (a slow enough manual retry would "happen" to land after registration finished).
// Fix: register the tool object synchronously in register(); resolve the token lazily (and cache
// it, so a secret-ref config doesn't re-hit the secret store on every call) inside execute().
async function resolveToken(
  api: OpenClawPluginApi,
  resolved: ResolvedHaControlConfig,
): Promise<string> {
  if (typeof resolved.token === "string") {
    return resolved.token;
  }
  const { value } = await resolveConfiguredSecretInputString({
    config: api.config,
    env: process.env,
    value: resolved.token,
    path: "plugins.entries.ha-control.config.token",
  });
  if (!value) {
    throw new Error("[ha-control] could not resolve HA token");
  }
  return value;
}

function createTokenResolver(
  api: OpenClawPluginApi,
  resolved: ResolvedHaControlConfig,
): () => Promise<string> {
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= resolveToken(api, resolved);
    return cached;
  };
}

export default definePluginEntry({
  id: "ha-control",
  name: "Home Assistant Control",
  description:
    "Gives MoaBot a bounded set of Home Assistant service-call actions, starting with Music Assistant playback.",
  register(api: OpenClawPluginApi) {
    const resolved = resolveHaControlPluginConfig({ pluginConfig: api.pluginConfig });
    const resolveTokenOnce = createTokenResolver(api, resolved);
    api.registerTool(
      createPlayMusicTool({
        baseUrl: resolved.baseUrl,
        resolveToken: resolveTokenOnce,
        defaultMediaPlayerEntityId: resolved.defaultMediaPlayerEntityId,
        musicAssistantConfigEntryId: resolved.musicAssistantConfigEntryId,
      }),
      { name: "play_music_on_satellite" },
    );
    api.registerTool(
      createPlaybackControlTool({
        baseUrl: resolved.baseUrl,
        resolveToken: resolveTokenOnce,
        defaultMediaPlayerEntityId: resolved.defaultMediaPlayerEntityId,
      }),
      { name: "control_satellite_playback" },
    );
    api.registerTool(
      createVolumeTool({
        baseUrl: resolved.baseUrl,
        resolveToken: resolveTokenOnce,
        defaultMediaPlayerEntityId: resolved.defaultMediaPlayerEntityId,
      }),
      { name: "set_satellite_volume" },
    );
    api.registerTool(
      createSleepTimerTool({
        baseUrl: resolved.baseUrl,
        resolveToken: resolveTokenOnce,
        timerEntityId: resolved.sleepTimerEntityId,
      }),
      { name: "set_sleep_timer" },
    );
    api.logger.info(
      `[ha-control] registered play_music_on_satellite, control_satellite_playback, ` +
        `set_satellite_volume, set_sleep_timer (target: ${resolved.baseUrl})`,
    );
  },
});
