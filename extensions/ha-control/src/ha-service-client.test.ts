// ha-control tests cover the Home Assistant REST service-call client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callHomeAssistantService, HomeAssistantServiceCallError } from "./ha-service-client.js";

describe("callHomeAssistantService", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to /api/services/<domain>/<service> with a bearer token and JSON body", async () => {
    fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));

    await callHomeAssistantService({
      baseUrl: "http://10.0.0.108:8123",
      token: "test-token",
      domain: "mass",
      service: "play_media",
      data: { entity_id: "media_player.moa", media_id: "Radiohead", media_type: "artist" },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://10.0.0.108:8123/api/services/mass/play_media");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(JSON.parse(init.body as string)).toEqual({
      entity_id: "media_player.moa",
      media_id: "Radiohead",
      media_type: "artist",
    });
  });

  it("strips a trailing slash from baseUrl before building the URL", async () => {
    fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));

    await callHomeAssistantService({
      baseUrl: "http://10.0.0.108:8123/",
      token: "t",
      domain: "mass",
      service: "play_media",
      data: {},
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://10.0.0.108:8123/api/services/mass/play_media");
  });

  it("throws HomeAssistantServiceCallError with status/body on a non-OK response", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));

    await expect(
      callHomeAssistantService({
        baseUrl: "http://10.0.0.108:8123",
        token: "t",
        domain: "mass",
        service: "play_media",
        data: {},
      }),
    ).rejects.toThrow(HomeAssistantServiceCallError);
  });
});
