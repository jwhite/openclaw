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

  it("registers play_music_on_satellite when config is a plain string token", async () => {
    const { api, registerTool } = createApi({ pluginConfig: VALID_CONFIG });

    plugin.register(api);
    await Promise.resolve();
    await Promise.resolve();

    expect(registerTool).toHaveBeenCalledOnce();
    const [tool, opts] = registerTool.mock.calls[0] as [{ name: string }, { name: string }];
    expect(tool.name).toBe("play_music_on_satellite");
    expect(opts).toEqual({ name: "play_music_on_satellite" });
  });

  it("registers the tool again on a second register() call instead of skipping it", async () => {
    // The runtime calls register() once per tool-registry snapshot it builds (observed live: a
    // plugin that only registers once misses every snapshot after the first, so real agent turns
    // never see the tool even though it appeared in startup logs). No ha-events-style guard here.
    const { api, registerTool } = createApi({ pluginConfig: VALID_CONFIG });

    plugin.register(api);
    await Promise.resolve();
    await Promise.resolve();
    plugin.register(api);
    await Promise.resolve();
    await Promise.resolve();

    expect(registerTool).toHaveBeenCalledTimes(2);
  });
});
