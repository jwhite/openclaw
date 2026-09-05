// ha-voice tests cover index plugin registration behavior.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

function createApi(params?: {
  pluginConfig?: OpenClawPluginApi["pluginConfig"];
  registerHttpRoute?: OpenClawPluginApi["registerHttpRoute"];
}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "ha-voice",
    name: "Home Assistant Voice",
    source: "test",
    pluginConfig: params?.pluginConfig ?? { secret: "shh" },
    runtime: {
      agent: {},
    } as unknown as OpenClawPluginApi["runtime"],
    registerHttpRoute: params?.registerHttpRoute ?? vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as OpenClawPluginApi["logger"],
  });
}

function requireFirstRouteRegistration(mock: ReturnType<typeof vi.fn>) {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected ha-voice route registration");
  }
  return call[0] as Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];
}

describe("ha-voice plugin registration", () => {
  it("registers the converse route with default path and agent", () => {
    const registerHttpRoute = vi.fn();

    plugin.register(createApi({ registerHttpRoute }));

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    const route = requireFirstRouteRegistration(registerHttpRoute);
    expect(route.path).toBe("/plugins/ha-voice/converse");
    expect(route.auth).toBe("plugin");
    expect(route.match).toBe("exact");
    expect(route.replaceExisting).toBe(true);
    expect(route.handler).toBeTypeOf("function");
  });

  it("honors a configured serve path and agentId", () => {
    const registerHttpRoute = vi.fn();

    plugin.register(
      createApi({
        registerHttpRoute,
        pluginConfig: {
          secret: "shh",
          agentId: "moabot",
          serve: { path: "/plugins/ha-voice/moabot" },
        },
      }),
    );

    const route = requireFirstRouteRegistration(registerHttpRoute);
    expect(route.path).toBe("/plugins/ha-voice/moabot");
  });

  it("throws when no secret is configured", () => {
    expect(() => plugin.register(createApi({ pluginConfig: {} }))).toThrow();
  });
});
