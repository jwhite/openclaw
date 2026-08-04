# ha-control

Gives MoaBot a **bounded** set of Home Assistant service-call actions, so voice requests can act
on the home, not just observe it (`ha-events`) or converse about it (`ha-voice`). Deliberately not
a generic "call any HA service" passthrough — see the root `AGENTS.md`-style caution in
`fairlead-ha/projects/spotify-playback/decisions/functional-requirements.md` (FR-9) about being
deliberate re: what writes MoaBot can take unprompted.

## What it does today

Three tools:

- **`play_music_on_satellite`** (targets `defaultMediaPlayerEntityId`) — starts playback via Music
  Assistant's `music_assistant.play_media` HA service (artist/album/track/playlist/audiobook by
  name). `media_id` is a required URI, not a free-text string — free text resolves through a
  separate `music_assistant.search` call first; see `src/play-music-tool.ts`'s header comment for
  the full list of gotchas found live (wrong service domain in early docs, required-URI `media_id`,
  wrong target entity, `search_options` 400ing).
- **`set_satellite_volume`** (targets `defaultMediaPlayerEntityId`) — absolute (0-100%) or relative
  (up/down) volume, via HA's standard `media_player.volume_set`/`volume_up`/`volume_down` — core HA
  services, none of the Music Assistant-specific gotchas apply.
- **`set_sleep_timer`** (targets `sleepTimerEntityId`) — starts/cancels a countdown via HA's
  standard `timer.start`/`timer.cancel`. This tool only manages the countdown; a separate HA
  automation (`sleep_timer_pause_playback`, in `automations.yaml`) handles `timer.finished` →
  `media_player.media_pause`. The `timer.sleep_timer` helper itself lives in HA's
  `configuration.yaml` (`restore: true` so it survives an HA restart) — `timer` helpers aren't
  config-entry/UI-creatable on this HA instance (confirmed live: not in
  `GET /api/config/config_entries/flow_handlers`), so it's YAML-only, not something this plugin
  can create for you.

All three play/act immediately, no confirmation gate (Operator decision, 2026-08-03: low-stakes,
easily reversible).

Routes through **Home Assistant's REST API**, not Music Assistant's own API directly — reuses the
same HA access `ha-events` already has (long-lived token) rather than adding a second
credential/connection just for playback.

## Config

```json
{
  "baseUrl": "http://10.0.0.108:8123",
  "token": { "source": "env", "provider": "infisical", "id": "..." },
  "defaultMediaPlayerEntityId": "media_player.home_assistant_voice_0aacc1",
  "musicAssistantConfigEntryId": "01KZ009H59A4M6ZRME5HESBGQ5",
  "sleepTimerEntityId": "timer.sleep_timer"
}
```

`token` accepts a plain string or the same secret-ref shape `ha-events` uses. `baseUrl` is the REST
API base (not the `/api/websocket` URL `ha-events` uses).

**`defaultMediaPlayerEntityId` must be the Music-Assistant-owned entity** (no `_media_player`
suffix), not the native ESPHome/Voice-PE entity — `music_assistant.play_media`'s target schema only
accepts entities from the `music_assistant` integration, and it's also the entity whose
`volume_level` attribute actually reflects active playback.

`musicAssistantConfigEntryId` is HA's `config_entries` `entry_id` for the Music Assistant
integration instance — find it via `GET /api/config/config_entries/entry`, filter `domain ==
"music_assistant"`.

## Deployment gotchas (inherited from ha-events/ha-voice — check these first)

1. Runtime needs **compiled JS** via `runtimeExtensions` (`./dist/index.js`), not the raw `./index.ts`
   `extensions` field — that's dev/typecheck-only.
2. A plugin can be `enabled: true` and still silently no-op unless its id is _also_ in the
   top-level `plugins.allow` array.
3. `activation.onStartup` must be `true`.
4. The manifest needs `contracts.tools` listing every tool name this plugin registers, or the
   runtime rejects `registerTool` calls with "plugin must declare contracts.tools before
   registering agent tools."
5. Files pushed via `pct push`/tar can end up owned by the wrong uid — OpenClaw's plugin loader
   silently blocks a plugin with unexpected file ownership. `chown -R 1000:1000` after any
   host-side file push, before restarting the container.
6. **`registerTool`'s factory contract is synchronous** (`OpenClawPluginToolFactory` returns
   `AnyAgentTool`, not a `Promise`) — the runtime builds a tool-registry snapshot immediately after
   `register()` returns. Register the tool object directly in `register()`; never defer it via a
   fire-and-forget async call (`void asyncFn()`), even though that pattern is fine in `ha-events`
   (which only opens a WebSocket, not populating a tool registry). A deferred registration is
   intermittently invisible to real conversation turns while still showing up in startup logs —
   easy to miss in casual testing. Resolve any async-only work (e.g. a secret-ref token) lazily
   inside the tool's own `execute()` instead, where it's always been safe.
7. If a tool was broken and got fixed, a device's **existing conversation session may still have
   the model's old "I don't have that tool" refusal baked into its history**, and it can keep
   repeating that even after the fix lands — new sessions work immediately, but that one specific
   session doesn't self-correct. Fix: `openclaw sessions compact "<session-key>" --max-lines 1`
   (official CLI, archives rather than deletes the old transcript). Find the exact key via
   `openclaw sessions list --json` (`ha-voice` keys look like
   `agent:<agentId>:ha-voice:<deviceId-or-"default">`).

## Extending

`S1.4` (voice volume) and `S1.5` (voice-triggered playback) and `S1.3` (sleep timer) — all of
Sprint 1's Musts that need HA writes — are now built here, all reusing
`callHomeAssistantService` rather than each building separate HA-write plumbing.
