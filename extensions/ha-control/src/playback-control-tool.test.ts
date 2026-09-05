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

  it("forward: reads the position from Music Assistant, then seeks +30s by default", async () => {
    callHomeAssistantService
      .mockResolvedValueOnce({ q1: { elapsed_time: 1000, current_item: { duration: 39097 } } })
      .mockResolvedValueOnce([]);
    const tool = await loadTool();

    const result = await tool.execute("f-1", { action: "forward" });

    // Position comes from music_assistant.get_queue, never the HA media_position attribute.
    expect(callHomeAssistantService).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        domain: "music_assistant",
        service: "get_queue",
        returnResponse: true,
      }),
    );
    expect(callHomeAssistantService).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        domain: "media_player",
        service: "media_seek",
        data: { entity_id: "media_player.home_assistant_voice_0aacc1", seek_position: 1030 },
      }),
    );
    expect(result).toMatchObject({
      details: { ok: true, action: "forward", fromSeconds: 1000, toSeconds: 1030 },
    });
  });

  it("back: subtracts the spoken amount from the authoritative position", async () => {
    callHomeAssistantService
      .mockResolvedValueOnce({ q1: { elapsed_time: 1000, current_item: { duration: 39097 } } })
      .mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("b-1", { action: "back", seconds: 120 });

    expect(callHomeAssistantService).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        service: "media_seek",
        data: { entity_id: "media_player.home_assistant_voice_0aacc1", seek_position: 880 },
      }),
    );
  });

  it("back past the start clamps to 0, never negative", async () => {
    callHomeAssistantService
      .mockResolvedValueOnce({ q1: { elapsed_time: 10, current_item: { duration: 39097 } } })
      .mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("b-2", { action: "back", seconds: 30 });

    expect(callHomeAssistantService).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ seek_position: 0 }) }),
    );
  });

  it("forward past the end clamps one second short, not to the finish", async () => {
    callHomeAssistantService
      .mockResolvedValueOnce({ q1: { elapsed_time: 39090, current_item: { duration: 39097 } } })
      .mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("f-2", { action: "forward", seconds: 30 });

    expect(callHomeAssistantService).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ seek_position: 39096 }) }),
    );
  });

  it("reports nothing playing when the queue is empty, without seeking", async () => {
    callHomeAssistantService.mockResolvedValueOnce({});
    const tool = await loadTool();

    const result = await tool.execute("f-3", { action: "forward" });

    expect(callHomeAssistantService).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ details: { ok: false, action: "forward" } });
  });
});
