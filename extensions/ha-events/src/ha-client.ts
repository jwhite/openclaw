// Long-lived, self-reconnecting Home Assistant WebSocket client, subscribed to state_changed.
//
// HA's WS handshake: server sends {type:"auth_required"} -> client sends
// {type:"auth", access_token} -> server sends {type:"auth_ok"|"auth_invalid"} -> client sends
// {type:"subscribe_events", event_type:"state_changed"} -> server streams {type:"event", event:{
//   event_type:"state_changed", data:{entity_id, old_state, new_state}}} frames.
import WebSocket from "ws";
import { computeBackoffDelayMs, type BackoffOptions } from "./backoff.js";
import { domainFromEntityId, type TrackedEvent } from "./event-store.js";

export type HaStateChangedPayload = {
  entityId: string;
  oldState: string | null;
  newState: string | null;
};

export type HaEventClientLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

export type HaEventClientOptions = {
  url: string;
  token: string;
  domains?: string[];
  logger: HaEventClientLogger;
  backoff?: BackoffOptions;
  onEvent: (event: TrackedEvent) => void;
  onConnected: () => void;
  onDisconnected: () => void;
};

const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 60_000, jitterRatio: 0.2 };

export class HaEventClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private msgId = 1;

  constructor(private readonly opts: HaEventClientOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
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

  private handleMessage(ws: WebSocket, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
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
        ws.send(
          JSON.stringify({
            id: this.msgId++,
            type: "subscribe_events",
            event_type: "state_changed",
          }),
        );
        this.opts.logger.info("[ha-events] subscribed to state_changed");
        return;
      case "event": {
        const payload = extractStateChangedPayload(msg);
        if (!payload) {
          return;
        }
        if (
          this.opts.domains &&
          !this.opts.domains.includes(domainFromEntityId(payload.entityId))
        ) {
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

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    const delayMs = computeBackoffDelayMs(
      this.reconnectAttempt,
      this.opts.backoff ?? DEFAULT_BACKOFF,
    );
    this.reconnectAttempt += 1;
    this.opts.logger.warn("[ha-events] websocket disconnected, reconnecting", {
      attempt: this.reconnectAttempt,
      delayMs,
    });
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
  }
}

export function extractStateChangedPayload(
  msg: Record<string, unknown>,
): HaStateChangedPayload | null {
  const event = msg.event as Record<string, unknown> | undefined;
  if (!event || event.event_type !== "state_changed") {
    return null;
  }
  const data = event.data as Record<string, unknown> | undefined;
  const entityId = data?.entity_id;
  if (typeof entityId !== "string") {
    return null;
  }
  const oldStateObj = data?.old_state as Record<string, unknown> | null | undefined;
  const newStateObj = data?.new_state as Record<string, unknown> | null | undefined;
  return {
    entityId,
    oldState: typeof oldStateObj?.state === "string" ? oldStateObj.state : null,
    newState: typeof newStateObj?.state === "string" ? newStateObj.state : null,
  };
}
