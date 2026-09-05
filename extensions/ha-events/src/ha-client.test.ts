import { describe, expect, it } from "vitest";
import { extractStateChangedPayload } from "./ha-client.js";

describe("extractStateChangedPayload", () => {
  it("extracts entity_id and old/new state from a real state_changed frame", () => {
    const msg = {
      type: "event",
      event: {
        event_type: "state_changed",
        data: {
          entity_id: "light.kitchen",
          old_state: { state: "off" },
          new_state: { state: "on" },
        },
      },
    };
    expect(extractStateChangedPayload(msg)).toEqual({
      entityId: "light.kitchen",
      oldState: "off",
      newState: "on",
    });
  });

  it("handles a null old_state (entity appearing for the first time)", () => {
    const msg = {
      type: "event",
      event: {
        event_type: "state_changed",
        data: {
          entity_id: "light.new",
          old_state: null,
          new_state: { state: "on" },
        },
      },
    };
    expect(extractStateChangedPayload(msg)).toEqual({
      entityId: "light.new",
      oldState: null,
      newState: "on",
    });
  });

  it("returns null for a non-state_changed event", () => {
    const msg = {
      type: "event",
      event: { event_type: "call_service", data: {} },
    };
    expect(extractStateChangedPayload(msg)).toBeNull();
  });

  it("returns null when entity_id is missing", () => {
    const msg = {
      type: "event",
      event: { event_type: "state_changed", data: {} },
    };
    expect(extractStateChangedPayload(msg)).toBeNull();
  });

  it("returns null for a message with no event field at all", () => {
    expect(extractStateChangedPayload({ type: "auth_ok" })).toBeNull();
  });
});
