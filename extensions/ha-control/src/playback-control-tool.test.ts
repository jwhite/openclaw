// ha-control tests cover the control_satellite_playback tool behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const callHomeAssistantService = vi.fn();

vi.mock("./ha-service-client.js", () => ({
  callHomeAssistantService,
}));

describe("createPlaybackControlTool", () => {
  beforeEach(() => {
    callHomeAssistantService.mockReset();
  });

  async function loadTool() {
    const { createPlaybackControlTool } = await import("./playback-control-tool.js");
    return createPlaybackControlTool({
      baseUrl: "http://10.0.0.108:8123",
      resolveToken: async () => "test-token",
      defaultMediaPlayerEntityId: "media_player.home_assistant_voice_0aacc1",
    });
  }

  it("calls media_player.media_stop for action=stop", async () => {
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    const result = await tool.execute("call-1", { action: "stop" });

    expect(callHomeAssistantService).toHaveBeenCalledWith({
      baseUrl: "http://10.0.0.108:8123",
      token: "test-token",
      domain: "media_player",
      service: "media_stop",
      data: { entity_id: "media_player.home_assistant_voice_0aacc1" },
    });
    expect(result).toMatchObject({ details: { ok: true, action: "stop" } });
  });

  it("calls media_player.media_pause for action=pause", async () => {
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("call-2", { action: "pause" });

    expect(callHomeAssistantService).toHaveBeenCalledWith(
      expect.objectContaining({ service: "media_pause" }),
    );
  });

  it("calls media_player.media_play for action=resume", async () => {
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("call-3", { action: "resume" });

    expect(callHomeAssistantService).toHaveBeenCalledWith(
      expect.objectContaining({ service: "media_play" }),
    );
  });

  it("targets the Music-Assistant-owned entity, not the native ESPHome media surface", async () => {
    // play_music_on_satellite starts the queue on the MA entity, so stopping anything else would
    // silently leave the music playing (see play-music-tool.ts's own comment on the two entities).
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("call-4", { action: "stop" });

    expect(callHomeAssistantService).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { entity_id: "media_player.home_assistant_voice_0aacc1" },
      }),
    );
  });

  it("rejects an invalid action, without calling Home Assistant", async () => {
    const tool = await loadTool();

    const result = await tool.execute("call-5", { action: "skip" });

    expect(callHomeAssistantService).not.toHaveBeenCalled();
    expect(result).toMatchObject({ details: { ok: false } });
  });

  it("reports a failed service call rather than throwing", async () => {
    callHomeAssistantService.mockRejectedValueOnce(new Error("boom"));
    const tool = await loadTool();

    const result = await tool.execute("call-6", { action: "stop" });

    expect(result).toMatchObject({ details: { ok: false, error: "boom" } });
  });
});
