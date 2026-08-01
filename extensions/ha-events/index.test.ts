// ha-events tests cover index plugin registration behavior.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

function createApi(params?: {
  pluginConfig?: OpenClawPluginApi["pluginConfig"];
}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "ha-events",
    name: "Home Assistant Event Ingestion",
    source: "test",
    pluginConfig: params?.pluginConfig ?? {},
    runtime: {
      state: {
        openSyncKeyedStore: vi.fn(() => ({
          registerIfAbsent: vi.fn(),
          update: vi.fn(),
          lookup: vi.fn(),
          consume: vi.fn(),
          delete: vi.fn(),
          entries: vi.fn(() => []),
          clear: vi.fn(),
          register: vi.fn(),
        })),
      },
    } as unknown as OpenClawPluginApi["runtime"],
    lifecycle: {
      registerRuntimeLifecycle: vi.fn(),
    } as unknown as OpenClawPluginApi["lifecycle"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as OpenClawPluginApi["logger"],
  });
}

describe("ha-events plugin registration", () => {
  it("throws synchronously when url is missing", () => {
    expect(() => plugin.register(createApi({ pluginConfig: { token: "shh" } }))).toThrow();
  });

  it("throws synchronously when token is missing", () => {
    expect(() =>
      plugin.register(createApi({ pluginConfig: { url: "ws://10.0.0.108:8123/api/websocket" } })),
    ).toThrow();
  });
});
