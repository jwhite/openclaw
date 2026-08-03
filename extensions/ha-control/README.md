# ha-control

Gives MoaBot a **bounded** set of Home Assistant service-call actions, so voice requests can act
on the home, not just observe it (`ha-events`) or converse about it (`ha-voice`). Deliberately not
a generic "call any HA service" passthrough — see the root `AGENTS.md`-style caution in
`fairlead-ha/projects/spotify-playback/decisions/functional-requirements.md` (FR-9) about being
deliberate re: what writes MoaBot can take unprompted.

## What it does today

One tool: **`play_music_on_satellite`** — starts playback on a configured `media_player` entity
via Music Assistant's `mass.play_media` Home Assistant service, which supports free-text search
(artist/album/track/playlist name) rather than requiring an exact media URI. Plays immediately, no
confirmation gate (Operator decision, 2026-08-03: low-stakes, easily reversible).

Routes through **Home Assistant's REST API**, not Music Assistant's own API directly — reuses the
same HA access `ha-events` already has (long-lived token) rather than adding a second
credential/connection just for playback.

## Config

```json
{
  "baseUrl": "http://10.0.0.108:8123",
  "token": { "source": "env", "provider": "infisical", "id": "..." },
  "defaultMediaPlayerEntityId": "media_player.home_assistant_voice_0aacc1_media_player"
}
```

`token` accepts a plain string or the same secret-ref shape `ha-events` uses. `baseUrl` is the REST
API base (not the `/api/websocket` URL `ha-events` uses).

## Deployment gotchas (inherited from ha-events/ha-voice — check these first)

1. Runtime needs **compiled JS** via `runtimeExtensions` (`./dist/index.js`), not the raw `./index.ts`
   `extensions` field — that's dev/typecheck-only.
2. A plugin can be `enabled: true` and still silently no-op unless its id is _also_ in the
   top-level `plugins.allow` array.
3. `activation.onStartup` must be `true`.
4. Files pushed via `pct push`/tar can end up owned by the wrong uid — OpenClaw's plugin loader
   silently blocks a plugin with unexpected file ownership. `chown -R 1000:1000` after any
   host-side file push, before restarting the container.

## Extending

`S1.3` (sleep timer) and `S1.4` (voice volume) in the `spotify-playback` project are expected to
add tools here (`timer.start`/`timer.cancel`, `media_player.volume_set`) reusing
`callHomeAssistantService` rather than building separate HA-write plumbing.
