import { describe, expect, it } from "vitest";
import { resolveHaEventsPluginConfig } from "./config.js";

describe("resolveHaEventsPluginConfig", () => {
  it("applies defaults when only url + token are configured", () => {
    const resolved = resolveHaEventsPluginConfig({
      pluginConfig: { url: "ws://10.0.0.108:8123/api/websocket", token: "shh" },
    });
    expect(resolved.url).toBe("ws://10.0.0.108:8123/api/websocket");
    expect(resolved.token).toBe("shh");
    expect(resolved.domains).toBeUndefined();
    expect(resolved.maxTrackedEvents).toBe(50);
  });

  it("accepts an explicit domains filter and maxTrackedEvents", () => {
    const resolved = resolveHaEventsPluginConfig({
      pluginConfig: {
        url: "ws://10.0.0.108:8123/api/websocket",
        token: "shh",
        domains: ["light", "switch"],
        maxTrackedEvents: 10,
      },
    });
    expect(resolved.domains).toEqual(["light", "switch"]);
    expect(resolved.maxTrackedEvents).toBe(10);
  });

  it("accepts a secretRef token", () => {
    const resolved = resolveHaEventsPluginConfig({
      pluginConfig: {
        url: "ws://10.0.0.108:8123/api/websocket",
        token: { source: "env", provider: "default", id: "HA_TOKEN" },
      },
    });
    expect(resolved.token).toEqual({ source: "env", provider: "default", id: "HA_TOKEN" });
  });

  it("throws when url is missing", () => {
    expect(() => resolveHaEventsPluginConfig({ pluginConfig: { token: "shh" } })).toThrow();
  });

  it("throws when token is missing", () => {
    expect(() =>
      resolveHaEventsPluginConfig({ pluginConfig: { url: "ws://x/api/websocket" } }),
    ).toThrow();
  });
});
