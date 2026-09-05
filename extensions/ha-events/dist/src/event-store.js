// Pure rolling-stats logic for tracked HA events, kept separate from the plugin-state store
// wrapper so it's testable without SQLite. The caller (index.ts) reads the current snapshot from
// the store, calls recordEvent, and writes the result back atomically via the store's `update`.
export function createEmptySnapshot() {
    return {
        totalCount: 0,
        domainCounts: {},
        recentEvents: [],
        lastEventAtMs: null,
        lastConnectedAtMs: null,
        disconnectCount: 0,
    };
}
export function recordEvent(snapshot, event, maxRecent) {
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
export function recordConnected(snapshot, atMs) {
    return { ...snapshot, lastConnectedAtMs: atMs };
}
export function recordDisconnected(snapshot) {
    return { ...snapshot, disconnectCount: snapshot.disconnectCount + 1 };
}
/** Extract the domain from an entity_id like "light.kitchen" -> "light". */
export function domainFromEntityId(entityId) {
    const dot = entityId.indexOf(".");
    return dot > 0 ? entityId.slice(0, dot) : entityId;
}
