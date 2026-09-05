// ha-events plugin entrypoint registers its OpenClaw integration.
import {
  definePluginEntry,
  resolveConfiguredSecretInputString,
  type OpenClawPluginApi,
} from "./api.js";
import { resolveHaEventsPluginConfig, type ResolvedHaEventsConfig } from "./src/config.js";
import {
  createEmptySnapshot,
  recordConnected,
  recordDisconnected,
  recordEvent,
  type EventStoreSnapshot,
} from "./src/event-store.js";
import { HaEventClient } from "./src/ha-client.js";

// In-process rolling snapshot. `runtime.state.openSyncKeyedStore` is restricted to trusted
// (bundled) plugins in this OpenClaw release, so a locally-installed plugin can't use it —
// confirmed by a real crash ("openKeyedStore is only available for trusted plugins in this
// release") the first time this was deployed. In-memory is a real trade-off (doesn't survive a
// restart), but this story's bar is "events visibly flowing," not durable cross-restart
// persistence — that's a fair scope call for now, not a shortcut taken carelessly.
let snapshot: EventStoreSnapshot = createEmptySnapshot();
let activeClient: HaEventClient | null = null;
// Set synchronously (before the first await) so two near-simultaneous register() calls can't
// both pass the guard check while the first is still mid-token-resolution.
let connectStarted = false;

export function getHaEventsSnapshot(): EventStoreSnapshot {
  return snapshot;
}

async function connectHaEventsClient(
  api: OpenClawPluginApi,
  resolved: ResolvedHaEventsConfig,
): Promise<void> {
  // register() has been observed running more than once for the same process (seen with
  // ha-voice too, during `openclaw plugins doctor`/`enable`) — guard so a second call can't open
  // a second live WebSocket, which would double every event and double the HA connection count.
  // Set synchronously, before the first await, so two near-simultaneous calls can't both pass.
  if (connectStarted) {
    api.logger.info("[ha-events] register() called again — client already running, skipping");
    return;
  }
  connectStarted = true;

  const token =
    typeof resolved.token === "string"
      ? resolved.token
      : (
          await resolveConfiguredSecretInputString({
            config: api.config,
            env: process.env,
            value: resolved.token,
            path: "plugins.entries.ha-events.config.token",
          })
        ).value;

  if (!token) {
    api.logger.error("[ha-events] could not resolve HA token — plugin will not connect");
    return;
  }

  const client = new HaEventClient({
    url: resolved.url,
    token,
    ...(resolved.domains ? { domains: resolved.domains } : {}),
    logger: api.logger,
    onConnected: () => {
      snapshot = recordConnected(snapshot, Date.now());
    },
    onDisconnected: () => {
      snapshot = recordDisconnected(snapshot);
    },
    onEvent: (event) => {
      snapshot = recordEvent(snapshot, event, resolved.maxTrackedEvents);
      api.logger.info(`[ha-events] ${event.entityId}: ${event.oldState} -> ${event.newState}`);
    },
  });

  activeClient = client;
  client.start();

  api.lifecycle.registerRuntimeLifecycle({
    id: "ha-events-client",
    description: "Closes the Home Assistant events WebSocket on shutdown.",
    cleanup: () => {
      client.stop();
      activeClient = null;
      connectStarted = false;
    },
  });

  api.logger.info(`[ha-events] started, connecting to ${resolved.url}`);
}

export default definePluginEntry({
  id: "ha-events",
  name: "Home Assistant Event Ingestion",
  description:
    "Subscribes to Home Assistant's state_changed events over WebSocket, with reconnect/backoff.",
  register(api: OpenClawPluginApi) {
    const resolved = resolveHaEventsPluginConfig({ pluginConfig: api.pluginConfig });
    void connectHaEventsClient(api, resolved);
  },
});
