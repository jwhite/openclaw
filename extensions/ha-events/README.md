# @openclaw/ha-events

S2.1 of the [fairlead-ha ha-voice project](https://github.com/jwhite/fairlead-ha/blob/main/projects/ha-voice/sprints.md#sprint-2--moabot-observes-out-of-the-voice-path).
Subscribes to Home Assistant's `state_changed` events over its WebSocket API, with automatic
reconnect/backoff, so MoaBot can observe the home without being anywhere near the voice-response
critical path (`ha-voice`'s job). This plugin does nothing with the events yet beyond tracking a
rolling in-memory snapshot and logging each one — turning them into something MoaBot actually acts
on (a diary, anomaly detection, ...) is S2.2/S2.3, deliberately out of scope here.

## Config

```json5
{
  url: "ws://10.0.0.108:8123/api/websocket",
  token: "<HA long-lived access token>", // or a secretRef, same shape as ha-voice's secret
  domains: ["light", "switch"], // optional allow-list; omit to track every domain
  maxTrackedEvents: 50, // rolling in-memory buffer size, default 50
}
```

## Deploying (same local-plugin pattern as `ha-voice`)

Same three gotchas documented in `ha-voice`'s README apply here too (compiled
`runtimeExtensions`, the `plugins.allow` gate, `activation.onStartup: true`) — see that plugin's
README for the full explanation. Two more, specific to this plugin, cost real debugging time on
first deploy:

1. **`runtime.state.openSyncKeyedStore` (and presumably the whole `runtime.state.*` keyed-store
   family) is restricted to trusted/bundled plugins in this OpenClaw release.** A locally
   installed plugin calling it throws `Error: openKeyedStore is only available for trusted
plugins in this release` — and critically, that error was an **unhandled promise rejection
   that crash-looped the entire gateway process** (confirmed via repeated "Unhandled promise
   rejection" + full boot-sequence restarts in `docker logs`, including affecting `ha-voice`
   since they share the process). Worked around by tracking the rolling event snapshot in a
   plain module-level in-memory variable instead — a real trade-off (doesn't survive a restart),
   accepted because this story's actual bar is "events visibly flowing," not durable
   cross-restart persistence.
2. **`register()` gets called more than once for the same plugin, in the same running process.**
   Confirmed by real duplicate log lines: every single HA event logged exactly twice,
   milliseconds apart, meaning two separate WebSocket connections both actually opened and both
   subscribed. (This is consistent with something noticed but not investigated while building
   `ha-voice` — its `register()` log line printed both during normal boot _and_ during
   `openclaw plugins doctor`/`enable` CLI invocations. `ha-voice` never showed a visible symptom
   because `registerHttpRoute` naturally deduplicates via `replaceExisting: true`; a plugin that
   opens a real stateful outbound connection in `register()` doesn't get that protection for
   free.) Fixed with an idempotency guard: a module-level flag set **synchronously, before the
   first `await`**, so two near-simultaneous `register()` calls can't both pass the check while
   the first is still mid-token-resolution. **Any future plugin whose `register()` has a real
   side effect (not just registering a route/hook) should assume `register()` can run more than
   once and guard accordingly** — this isn't specific to `ha-events`.

## Status

**Deployed and verified live 2026-07-29** on the real OpenClaw instance (LXC 100) — confirmed via
`docker logs`: clean connect, `subscribed to state_changed`, and a continuous stream of real HA
events (temps, power sensors, camera state, the 3D printer's Klipper sensors, mangosteen's system
load) flowing in with no duplicates and no crashes after the two fixes above.
