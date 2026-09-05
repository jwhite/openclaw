// ha-control tests cover the set_sleep_timer tool behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const callHomeAssistantService = vi.fn();

vi.mock("./ha-service-client.js", () => ({
  callHomeAssistantService,
}));

describe("createSleepTimerTool", () => {
  beforeEach(() => {
    callHomeAssistantService.mockReset();
  });

  async function loadTool() {
    const { createSleepTimerTool } = await import("./sleep-timer-tool.js");
    return createSleepTimerTool({
      baseUrl: "http://10.0.0.108:8123",
      resolveToken: async () => "test-token",
      timerEntityId: "timer.sleep_timer",
    });
  }

  it("calls timer.start with an HH:MM:SS duration for action=start", async () => {
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    const result = await tool.execute("call-1", { action: "start", minutes: 30 });

    expect(callHomeAssistantService).toHaveBeenCalledWith({
      baseUrl: "http://10.0.0.108:8123",
      token: "test-token",
      domain: "timer",
      service: "start",
      data: { entity_id: "timer.sleep_timer", duration: "00:30:00" },
    });
    expect(result).toMatchObject({ details: { ok: true, action: "start", minutes: 30 } });
  });

  it("formats sub-hour and multi-hour durations correctly", async () => {
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("call-2", { action: "start", minutes: 90 });

    expect(callHomeAssistantService).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ duration: "01:30:00" }) }),
    );
  });

  it("calls timer.cancel with no duration field for action=cancel", async () => {
    callHomeAssistantService.mockResolvedValueOnce([]);
    const tool = await loadTool();

    await tool.execute("call-3", { action: "cancel" });

    expect(callHomeAssistantService).toHaveBeenCalledWith({
      baseUrl: "http://10.0.0.108:8123",
      token: "test-token",
      domain: "timer",
      service: "cancel",
      data: { entity_id: "timer.sleep_timer" },
    });
  });

  it("rejects action=start without minutes, without calling Home Assistant", async () => {
    const tool = await loadTool();

    const result = await tool.execute("call-4", { action: "start" });

    expect(callHomeAssistantService).not.toHaveBeenCalled();
    expect(result).toMatchObject({ details: { ok: false } });
  });

  it("rejects an invalid action, without calling Home Assistant", async () => {
    const tool = await loadTool();

    const result = await tool.execute("call-5", { action: "pause" });

    expect(callHomeAssistantService).not.toHaveBeenCalled();
    expect(result).toMatchObject({ details: { ok: false } });
  });

  it("returns ok:false instead of throwing when the service call fails", async () => {
    callHomeAssistantService.mockRejectedValueOnce(new Error("boom"));
    const tool = await loadTool();

    const result = await tool.execute("call-6", { action: "cancel" });

    expect(result).toMatchObject({ details: { ok: false, error: "boom" } });
  });
});
