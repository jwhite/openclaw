import { describe, expect, it } from "vitest";
import { formatDiaryContent } from "./mempalace-diary.js";

describe("formatDiaryContent", () => {
  it("formats the said/response pair with an ISO timestamp", () => {
    const content = formatDiaryContent({
      mempalaceUrl: "http://mempalace-mcp:3001/sse",
      said: "turn off the bedroom lights",
      response: "Turned off the bedroom lights.",
      timestampMs: Date.parse("2026-07-29T14:32:00.000Z"),
      logger: { warn: () => {} },
    });
    expect(content).toBe(
      '[2026-07-29T14:32:00.000Z] Voice: "turn off the bedroom lights" → Response: "Turned off the bedroom lights."',
    );
  });

  it("includes the device id when present", () => {
    const content = formatDiaryContent({
      mempalaceUrl: "http://mempalace-mcp:3001/sse",
      said: "say pineapple",
      response: "pineapple",
      deviceId: "moa-voice-bedroom",
      timestampMs: Date.parse("2026-07-29T14:32:00.000Z"),
      logger: { warn: () => {} },
    });
    expect(content).toBe(
      '[2026-07-29T14:32:00.000Z] (device: moa-voice-bedroom) Voice: "say pineapple" → Response: "pineapple"',
    );
  });

  it("omits the device segment when deviceId is absent", () => {
    const content = formatDiaryContent({
      mempalaceUrl: "http://mempalace-mcp:3001/sse",
      said: "hello",
      response: "hi",
      timestampMs: Date.parse("2026-07-29T00:00:00.000Z"),
      logger: { warn: () => {} },
    });
    expect(content).not.toContain("device:");
  });
});
