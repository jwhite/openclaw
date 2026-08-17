// ha-control tests cover index plugin registration behavior.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

const VALID_CONFIG = {
  baseUrl: "http://10.0.0.108:8123",
  token: "shh",
  defaultMediaPlayerEntityId: "media_player.moa",
  musicAssistantConfigEntryId: "entry-123",
  sleepTimerEntityId: "timer.sleep_timer",
};

function createApi(params?: { pluginConfig?: OpenClawPluginApi["pluginConfig"] }): {
  api: OpenClawPluginApi;
  registerTool: ReturnType<typeof vi.fn>;
} {
  const registerTool = vi.fn();
  const api = createTestPluginApi({
    id: "ha-control",
    name: "Home Assistant Control",
    source: "test",
    pluginConfig: params?.pluginConfig ?? {},
    registerTool,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as OpenClawPluginApi["logger"],
  });
  return { api, registerTool };
}

describe("ha-control plugin registration", () => {
  it("throws synchronously when baseUrl is missing", () => {
    const { baseUrl: _omit, ...rest } = VALID_CONFIG;
    const { api } = createApi({ pluginConfig: rest });
    expect(() => plugin.register(api)).toThrow();
  });

  it("throws synchronously when token is missing", () => {
    const { token: _omit, ...rest } = VALID_CONFIG;
    const { api } = createApi({ pluginConfig: rest });
    expect(() => plugin.register(api)).toThrow();
  });

  it("throws synchronously when defaultMediaPlayerEntityId is missing", () => {
    const { defaultMediaPlayerEntityId: _omit, ...rest } = VALID_CONFIG;
    const { api } = createApi({ pluginConfig: rest });
    expect(() => plugin.register(api)).toThrow();
  });

  it("throws synchronously when musicAssistantConfigEntryId is missing", () => {
    const { musicAssistantConfigEntryId: _omit, ...rest } = VALID_CONFIG;
    const { api } = createApi({ pluginConfig: rest });
    expect(() => plugin.register(api)).toThrow();
  });

  it("throws synchronously when sleepTimerEntityId is missing", () => {
    const { sleepTimerEntityId: _omit, ...rest } = VALID_CONFIG;
    const { api } = createApi({ pluginConfig: rest });
    expect(() => plugin.register(api)).toThrow();
  });

  it("registers every tool SYNCHRONOUSLY within register(), no microtask needed", () => {
    // The real bug (2026-08-03): registerTool's factory contract is synchronous — the runtime
    // builds a tool-registry snapshot immediately after register() returns. The original
    // implementation deferred registration via `void asyncFn()`, so register() returned before
    // the tool was actually registered; snapshots built in that window never saw the tool, even
    // though it appeared in startup logs once the deferred call eventually finished. This test
    // asserts registerTool has already been called the instant plugin.register(api) returns —
    // deliberately does NOT await anything, so it would fail against the old implementation.
    const { api, registerTool } = createApi({ pluginConfig: VALID_CONFIG });

    plugin.register(api);

    expect(registerTool).toHaveBeenCalledTimes(4);
    const names = registerTool.mock.calls.map(([tool]) => (tool as { name: string }).name);
    expect(names).toEqual([
      "play_music_on_satellite",
      "control_satellite_playback",
      "set_satellite_volume",
      "set_sleep_timer",
    ]);
  });

  it("registers every tool again on a second register() call instead of skipping them", () => {
    // The runtime calls register() once per tool-registry snapshot it builds — a plugin that only
    // registers once misses every snapshot after the first. No ha-events-style "only run once"
    // guard here; registration is cheap and idempotent, so re-running it every time is correct.
    const { api, registerTool } = createApi({ pluginConfig: VALID_CONFIG });

    plugin.register(api);
    plugin.register(api);

    expect(registerTool).toHaveBeenCalledTimes(8);
  });

  it("the registered tool resolves a plain-string token asynchronously inside execute()", async () => {
    const { api, registerTool } = createApi({ pluginConfig: VALID_CONFIG });

    plugin.register(api);

    const [tool] = registerTool.mock.calls[0] as [
      { execute: (id: string, params: unknown) => Promise<{ details: { ok: boolean } }> },
    ];
    const result = await tool.execute("call-1", { query: "" });

    // Empty query short-circuits before any HA call, but still proves execute() runs the deferred
    // token-resolution path without throwing — the real proof of live playback is index.test.ts's
    // sibling, play-music-tool.test.ts, which mocks the HA client directly.
    expect(result.details.ok).toBe(false);
  });
});
