// ha-control tests cover the set_satellite_volume tool behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const callHomeAssistantService = vi.fn();

vi.mock("./ha-service-client.js", () => ({
  callHomeAssistantService,
}));

describe("createVolumeTool", () => {
  beforeEach(() => {
    callHomeAssistantService.mockReset();
  });

  async function loadTool() {
    const { createVolumeTool } = await import("./volume-tool.js");
    return createVolumeTool({
      baseUrl: "http://10.0.0.108:8123",
      resolveToken: async () => "test-token",
      defaultMediaPlayerEntityId: "media_player.home_assistant_voice_0aacc1",
    });
  }

  it("calls media_player.volume_set with a 0-1 fraction for action=set", async () => {
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    const result = await tool.execute("call-1", { action: "set", level: 40 });

    expect(callHomeAssistantService).toHaveBeenCalledWith({
      baseUrl: "http://10.0.0.108:8123",
      token: "test-token",
      domain: "media_player",
      service: "volume_set",
      data: {
        entity_id: "media_player.home_assistant_voice_0aacc1",
        volume_level: 0.4,
      },
    });
    expect(result).toMatchObject({ details: { ok: true, action: "set", level: 40 } });
  });

  it("calls media_player.volume_up for action=up with no volume_level field", async () => {
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("call-2", { action: "up" });

    expect(callHomeAssistantService).toHaveBeenCalledWith({
      baseUrl: "http://10.0.0.108:8123",
      token: "test-token",
      domain: "media_player",
      service: "volume_up",
      data: { entity_id: "media_player.home_assistant_voice_0aacc1" },
    });
  });

  it("calls media_player.volume_down for action=down", async () => {
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("call-3", { action: "down" });

    expect(callHomeAssistantService).toHaveBeenCalledWith(
      expect.objectContaining({ service: "volume_down" }),
    );
  });

  it("rejects action=set without a level, without calling Home Assistant", async () => {
    const tool = await loadTool();

    const result = await tool.execute("call-4", { action: "set" });

    expect(callHomeAssistantService).not.toHaveBeenCalled();
    expect(result).toMatchObject({ details: { ok: false } });
  });

  it("rejects an invalid action, without calling Home Assistant", async () => {
    const tool = await loadTool();

    const result = await tool.execute("call-5", { action: "sideways" });

    expect(callHomeAssistantService).not.toHaveBeenCalled();
    expect(result).toMatchObject({ details: { ok: false } });
  });

  it("returns ok:false instead of throwing when the service call fails", async () => {
    callHomeAssistantService.mockRejectedValueOnce(new Error("boom"));
    const tool = await loadTool();

    const result = await tool.execute("call-6", { action: "up" });

    expect(result).toMatchObject({ details: { ok: false, error: "boom" } });
  });
});
