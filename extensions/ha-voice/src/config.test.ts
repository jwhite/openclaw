import { describe, expect, it } from "vitest";
import { resolveHaVoicePluginConfig, resolveHaVoiceSessionKey } from "./config.js";

describe("resolveHaVoicePluginConfig", () => {
  it("applies defaults when only a secret is configured", () => {
    const resolved = resolveHaVoicePluginConfig({ pluginConfig: { secret: "shh" } });
    expect(resolved.path).toBe("/plugins/ha-voice/converse");
    expect(resolved.sessionScope).toBe("per-device");
    expect(resolved.agentId).toBeUndefined();
    expect(resolved.secret).toBe("shh");
  });

  it("honors an explicit serve path", () => {
    const resolved = resolveHaVoicePluginConfig({
      pluginConfig: { secret: "shh", serve: { path: "/plugins/ha-voice/custom" } },
    });
    expect(resolved.path).toBe("/plugins/ha-voice/custom");
  });

  it("accepts a secretRef object", () => {
    const resolved = resolveHaVoicePluginConfig({
      pluginConfig: {
        secret: { source: "env", provider: "default", id: "HA_VOICE_SECRET" },
      },
    });
    expect(resolved.secret).toEqual({ source: "env", provider: "default", id: "HA_VOICE_SECRET" });
  });

  it("throws when secret is missing", () => {
    expect(() => resolveHaVoicePluginConfig({ pluginConfig: {} })).toThrow();
  });
});

describe("resolveHaVoiceSessionKey", () => {
  it("scopes per-device sessions by deviceId", () => {
    expect(
      resolveHaVoiceSessionKey({
        agentId: "main",
        sessionScope: "per-device",
        deviceId: "Bedroom",
      }),
    ).toBe("agent:main:ha-voice:bedroom");
  });

  it("falls back to a default device bucket when no deviceId is given", () => {
    expect(resolveHaVoiceSessionKey({ agentId: "main", sessionScope: "per-device" })).toBe(
      "agent:main:ha-voice:default",
    );
  });

  it("pools every device onto one session in shared scope", () => {
    expect(
      resolveHaVoiceSessionKey({ agentId: "main", sessionScope: "shared", deviceId: "Bedroom" }),
    ).toBe("agent:main:ha-voice");
  });
});
