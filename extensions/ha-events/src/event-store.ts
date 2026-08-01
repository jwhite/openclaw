// Pure rolling-stats logic for tracked HA events, kept separate from the plugin-state store
// wrapper so it's testable without SQLite. The caller (index.ts) reads the current snapshot from
// the store, calls recordEvent, and writes the result back atomically via the store's `update`.

export type TrackedEvent = {
  entityId: string;
  domain: string;
  oldState: string | null;
  newState: string | null;
  timestampMs: number;
};

export type EventStoreSnapshot = {
  totalCount: number;
  domainCounts: Record<string, number>;
  recentEvents: TrackedEvent[];
  lastEventAtMs: number | null;
  lastConnectedAtMs: number | null;
  disconnectCount: number;
};

export function createEmptySnapshot(): EventStoreSnapshot {
  return {
    totalCount: 0,
    domainCounts: {},
    recentEvents: [],
    lastEventAtMs: null,
    lastConnectedAtMs: null,
    disconnectCount: 0,
  };
}

export function recordEvent(
  snapshot: EventStoreSnapshot,
  event: TrackedEvent,
  maxRecent: number,
): EventStoreSnapshot {
  const recentEvents = [event, ...snapshot.recentEvents].slice(0, Math.max(0, maxRecent));
  return {
    ...snapshot,
    totalCount: snapshot.totalCount + 1,
    domainCounts: {
      ...snapshot.domainCounts,
      [event.domain]: (snapshot.domainCounts[event.domain] ?? 0) + 1,
    },
    recentEvents,
    lastEventAtMs: event.timestampMs,
  };
}

export function recordConnected(snapshot: EventStoreSnapshot, atMs: number): EventStoreSnapshot {
  return { ...snapshot, lastConnectedAtMs: atMs };
}

export function recordDisconnected(snapshot: EventStoreSnapshot): EventStoreSnapshot {
  return { ...snapshot, disconnectCount: snapshot.disconnectCount + 1 };
}

/** Extract the domain from an entity_id like "light.kitchen" -> "light". */
export function domainFromEntityId(entityId: string): string {
  const dot = entityId.indexOf(".");
  return dot > 0 ? entityId.slice(0, dot) : entityId;
}
