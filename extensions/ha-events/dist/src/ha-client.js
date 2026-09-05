// Long-lived, self-reconnecting Home Assistant WebSocket client, subscribed to state_changed.
//
// HA's WS handshake: server sends {type:"auth_required"} -> client sends
// {type:"auth", access_token} -> server sends {type:"auth_ok"|"auth_invalid"} -> client sends
// {type:"subscribe_events", event_type:"state_changed"} -> server streams {type:"event", event:{
//   event_type:"state_changed", data:{entity_id, old_state, new_state}}} frames.
import WebSocket from "ws";
import { computeBackoffDelayMs } from "./backoff.js";
import { domainFromEntityId } from "./event-store.js";
const DEFAULT_BACKOFF = { baseMs: 1_000, maxMs: 60_000, jitterRatio: 0.2 };
export class HaEventClient {
    constructor(opts) {
        this.opts = opts;
        this.ws = null;
        this.stopped = false;
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.msgId = 1;
    }
    start() {
        this.stopped = false;
        this.connect();
    }
    stop() {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.ws?.close();
        this.ws = null;
    }
    connect() {
        if (this.stopped) {
            return;
        }
        const ws = new WebSocket(this.opts.url);
        this.ws = ws;
        ws.on("open", () => {
            this.opts.logger.info("[ha-events] websocket connected");
        });
        ws.on("message", (raw) => {
            this.handleMessage(ws, raw.toString());
        });
        ws.on("error", (err) => {
            this.opts.logger.warn("[ha-events] websocket error", { message: String(err) });
        });
        ws.on("close", () => {
            this.opts.onDisconnected();
            this.ws = null;
            this.scheduleReconnect();
        });
    }
    handleMessage(ws, raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        switch (msg.type) {
            case "auth_required":
                ws.send(JSON.stringify({ type: "auth", access_token: this.opts.token }));
                return;
            case "auth_invalid":
                this.opts.logger.warn("[ha-events] auth rejected by Home Assistant — check the token");
                ws.close();
                return;
            case "auth_ok":
                this.reconnectAttempt = 0;
                this.opts.onConnected();
                ws.send(JSON.stringify({
                    id: this.msgId++,
                    type: "subscribe_events",
                    event_type: "state_changed",
                }));
                this.opts.logger.info("[ha-events] subscribed to state_changed");
                return;
            case "event": {
                const payload = extractStateChangedPayload(msg);
                if (!payload) {
                    return;
                }
                if (this.opts.domains && !this.opts.domains.includes(domainFromEntityId(payload.entityId))) {
                    return;
                }
                this.opts.onEvent({
                    entityId: payload.entityId,
                    domain: domainFromEntityId(payload.entityId),
                    oldState: payload.oldState,
                    newState: payload.newState,
                    timestampMs: Date.now(),
                });
                return;
            }
            default:
                return;
        }
    }
    scheduleReconnect() {
        if (this.stopped) {
            return;
        }
        const delayMs = computeBackoffDelayMs(this.reconnectAttempt, this.opts.backoff ?? DEFAULT_BACKOFF);
        this.reconnectAttempt += 1;
        this.opts.logger.warn("[ha-events] websocket disconnected, reconnecting", {
            attempt: this.reconnectAttempt,
            delayMs,
        });
        this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
    }
}
export function extractStateChangedPayload(msg) {
    const event = msg.event;
    if (!event || event.event_type !== "state_changed") {
        return null;
    }
    const data = event.data;
    const entityId = data?.entity_id;
    if (typeof entityId !== "string") {
        return null;
    }
    const oldStateObj = data?.old_state;
    const newStateObj = data?.new_state;
    return {
        entityId,
        oldState: typeof oldStateObj?.state === "string" ? oldStateObj.state : null,
        newState: typeof newStateObj?.state === "string" ? newStateObj.state : null,
    };
}
