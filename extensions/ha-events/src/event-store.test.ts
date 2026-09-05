import { describe, expect, it } from "vitest";
import {
  createEmptySnapshot,
  domainFromEntityId,
  recordConnected,
  recordDisconnected,
  recordEvent,
  type TrackedEvent,
} from "./event-store.js";

const makeEvent = (overrides: Partial<TrackedEvent> = {}): TrackedEvent => ({
  entityId: "light.kitchen",
  domain: "light",
  oldState: "off",
  newState: "on",
  timestampMs: 1000,
  ...overrides,
});

describe("domainFromEntityId", () => {
  it("extracts the domain before the first dot", () => {
    expect(domainFromEntityId("light.kitchen")).toBe("light");
    expect(domainFromEntityId("assist_satellite.moa_voice_bedroom")).toBe("assist_satellite");
  });

  it("returns the whole string when there's no dot", () => {
    expect(domainFromEntityId("nodot")).toBe("nodot");
  });
});

describe("recordEvent", () => {
  it("increments totalCount and the per-domain count", () => {
    const snapshot = recordEvent(createEmptySnapshot(), makeEvent(), 50);
    expect(snapshot.totalCount).toBe(1);
    expect(snapshot.domainCounts.light).toBe(1);
    expect(snapshot.lastEventAtMs).toBe(1000);
  });

  it("accumulates counts across multiple events and domains", () => {
    let snapshot = createEmptySnapshot();
    snapshot = recordEvent(snapshot, makeEvent({ domain: "light", timestampMs: 1 }), 50);
    snapshot = recordEvent(snapshot, makeEvent({ domain: "light", timestampMs: 2 }), 50);
    snapshot = recordEvent(snapshot, makeEvent({ domain: "switch", timestampMs: 3 }), 50);
    expect(snapshot.totalCount).toBe(3);
    expect(snapshot.domainCounts.light).toBe(2);
    expect(snapshot.domainCounts.switch).toBe(1);
    expect(snapshot.lastEventAtMs).toBe(3);
  });

  it("keeps recentEvents newest-first and caps at maxRecent", () => {
    let snapshot = createEmptySnapshot();
    for (let i = 0; i < 5; i++) {
      snapshot = recordEvent(snapshot, makeEvent({ entityId: `light.${i}`, timestampMs: i }), 3);
    }
    expect(snapshot.recentEvents).toHaveLength(3);
    expect(snapshot.recentEvents.map((e) => e.entityId)).toEqual(["light.4", "light.3", "light.2"]);
  });

  it("does not mutate the input snapshot", () => {
    const original = createEmptySnapshot();
    recordEvent(original, makeEvent(), 50);
    expect(original.totalCount).toBe(0);
    expect(original.recentEvents).toHaveLength(0);
  });
});

describe("recordConnected / recordDisconnected", () => {
  it("sets lastConnectedAtMs on connect", () => {
    const snapshot = recordConnected(createEmptySnapshot(), 5000);
    expect(snapshot.lastConnectedAtMs).toBe(5000);
  });

  it("increments disconnectCount on disconnect", () => {
    let snapshot = createEmptySnapshot();
    snapshot = recordDisconnected(snapshot);
    snapshot = recordDisconnected(snapshot);
    expect(snapshot.disconnectCount).toBe(2);
  });
});
