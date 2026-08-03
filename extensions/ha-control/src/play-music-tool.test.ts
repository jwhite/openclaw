// ha-control tests cover the play_music_on_satellite tool behavior (search-then-play).
import { beforeEach, describe, expect, it, vi } from "vitest";

const callHomeAssistantService = vi.fn();

vi.mock("./ha-service-client.js", () => ({
  callHomeAssistantService,
}));

describe("createPlayMusicTool", () => {
  beforeEach(() => {
    callHomeAssistantService.mockReset();
  });

  async function loadTool() {
    const { createPlayMusicTool } = await import("./play-music-tool.js");
    return createPlayMusicTool({
      baseUrl: "http://10.0.0.108:8123",
      token: "test-token",
      defaultMediaPlayerEntityId: "media_player.home_assistant_voice_0aacc1",
      musicAssistantConfigEntryId: "entry-123",
    });
  }

  it("searches, resolves a URI, then plays it — defaulting media_type to track", async () => {
    callHomeAssistantService.mockResolvedValueOnce({
      tracks: [{ uri: "spotify://track/abc", name: "Bohemian Rhapsody" }],
    });
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    const result = await tool.execute("call-1", { query: "Bohemian Rhapsody" });

    expect(callHomeAssistantService).toHaveBeenNthCalledWith(1, {
      baseUrl: "http://10.0.0.108:8123",
      token: "test-token",
      domain: "music_assistant",
      service: "search",
      returnResponse: true,
      data: {
        config_entry_id: "entry-123",
        name: "Bohemian Rhapsody",
        media_type: ["track"],
      },
    });
    expect(callHomeAssistantService).toHaveBeenNthCalledWith(2, {
      baseUrl: "http://10.0.0.108:8123",
      token: "test-token",
      domain: "music_assistant",
      service: "play_media",
      data: {
        entity_id: "media_player.home_assistant_voice_0aacc1",
        media_id: "spotify://track/abc",
        media_type: "track",
      },
    });
    expect(result).toMatchObject({ details: { ok: true, mediaUri: "spotify://track/abc" } });
  });

  it("searches under the right result key for a non-default media_type", async () => {
    callHomeAssistantService.mockResolvedValueOnce({
      artists: [{ uri: "spotify://artist/u2", name: "U2" }],
    });
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("call-2", { query: "U2", media_type: "artist" });

    expect(callHomeAssistantService).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ media_type: ["artist"] }) }),
    );
    expect(callHomeAssistantService).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ media_id: "spotify://artist/u2" }),
      }),
    );
  });

  it("searches the audiobooks result key for media_type=audiobook", async () => {
    callHomeAssistantService.mockResolvedValueOnce({
      audiobooks: [{ uri: "audible://book/xyz", name: "Some Book" }],
    });
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("call-audiobook", { query: "Some Book", media_type: "audiobook" });

    expect(callHomeAssistantService).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ media_type: ["audiobook"] }) }),
    );
    expect(callHomeAssistantService).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ media_id: "audible://book/xyz" }),
      }),
    );
  });

  it("falls back to track for an unrecognized media_type instead of passing it through", async () => {
    callHomeAssistantService.mockResolvedValueOnce({ tracks: [{ uri: "spotify://track/x" }] });
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("call-3", { query: "x", media_type: "not-a-real-type" });

    expect(callHomeAssistantService).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ media_type: ["track"] }) }),
    );
  });

  it("rejects an empty query without calling Home Assistant at all", async () => {
    const tool = await loadTool();

    const result = await tool.execute("call-4", { query: "   " });

    expect(callHomeAssistantService).not.toHaveBeenCalled();
    expect(result).toMatchObject({ details: { ok: false } });
  });

  it("returns ok:false with no match when search finds nothing, without calling play_media", async () => {
    callHomeAssistantService.mockResolvedValueOnce({ tracks: [] });
    const tool = await loadTool();

    const result = await tool.execute("call-5", { query: "asdfghjkl nonexistent" });

    expect(callHomeAssistantService).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ details: { ok: false } });
  });

  it("returns ok:false instead of throwing when a service call fails", async () => {
    callHomeAssistantService.mockRejectedValueOnce(new Error("boom"));
    const tool = await loadTool();

    const result = await tool.execute("call-6", { query: "x" });

    expect(result).toMatchObject({ details: { ok: false, error: "boom" } });
  });
});
