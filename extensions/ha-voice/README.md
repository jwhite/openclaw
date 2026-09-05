# @openclaw/ha-voice

Bridges a Home Assistant Assist pipeline to a real OpenClaw agent, so a paired voice satellite
talks to the agent directly — not HA's built-in intent-only conversation agent. Built for the
[fairlead-ha ha-voice project](https://github.com/jwhite/fairlead-ha) (Sprint 1, S1.7).

**Scope:** this plugin is the OpenClaw-side half only. It exposes one authenticated HTTP endpoint
that takes a transcript and returns a spoken-ready text response. The other half — a small custom
Home Assistant `conversation` platform integration that calls this endpoint and gets selected as
the Assist pipeline's `conversation_engine` — still needs to be built on the HA side.

Speech-to-text (Wyoming/Whisper) and text-to-speech (Piper) are untouched by this plugin; only
the pipeline's conversation step routes here instead of `conversation.home_assistant`.

## Install

Local/private plugin — not published. Add it as an extension directory and enable via config
(see below); it's picked up as an `extensions/*` workspace package.

## Config

Put under `plugins.entries.ha-voice.config`:

```json5
{
  // Which OpenClaw agent answers. Defaults to the runtime's default agent ("main").
  agentId: "main",

  // "per-device" (default): one persistent session per calling satellite (keyed by the
  // request's deviceId), so MoaBot remembers the ongoing conversation with that device.
  // "shared": every device pools onto one session — fine for a single-satellite home.
  sessionScope: "per-device",

  // Optional system-prompt override. Default: "You are <agent name>, answering through a
  // Home Assistant voice satellite. Keep responses brief... You have access to tools..."
  responseSystemPrompt: undefined,

  // Optional per-turn timeout override; defaults to agents.defaults.timeoutSeconds.
  responseTimeoutMs: undefined,

  serve: {
    // HTTP path on the existing OpenClaw gateway/plugin HTTP server (no separate port —
    // this rides the same server voice-call/webhooks register routes on).
    path: "/plugins/ha-voice/converse",
  },

  // Shared secret HA must present. String literal or a secretRef (env/file/exec), same shape
  // as the webhooks plugin uses.
  secret: {
    source: "env",
    provider: "default",
    id: "HA_VOICE_SECRET",
  },
}
```

## Request / response contract

```
POST <gateway-host>:<gateway-port>/plugins/ha-voice/converse
Authorization: Bearer <secret>   (or header: X-OpenClaw-Ha-Voice-Secret: <secret>)
Content-Type: application/json

{ "text": "what's the weather like", "deviceId": "moa-voice-bedroom" }
```

```json
{ "ok": true, "response": "It's a clear evening, about 14 degrees." }
```

`deviceId` is optional — omit it (or use `sessionScope: "shared"`) for a single-satellite setup.
It should be a stable identifier for the calling satellite (e.g. its HA device id) so
conversation memory doesn't bleed between physically different rooms.

Error responses: `400` invalid request body, `401` bad/missing secret, `502` the agent run
produced nothing speakable (check server logs), `429`/`503` rate-limited or over the in-flight
cap (same webhook guard defaults `webhooks` uses).

## How a response is generated

Runs a real turn through `runtime.agent.runEmbeddedAgent` — the same core engine every channel
uses, with the agent's real identity/tools/memory, not a stripped-down mode. **The model is
overridden to `openrouter/moonshotai/kimi-k2.5`** rather than inheriting the agent's
general-purpose default — measured 2026-07-29, the inherited default (a large reasoning model)
took 16-21s per trivial turn and made multiple sequential provider round trips per turn, well
past a spoken conversation's usability bar. The override trades some reasoning depth for latency
on voice turns specifically; text/Slack conversations are unaffected. The `lane` is also keyed
per session (`ha-voice:<sessionKey>`, so per-device under the default `per-device` session scope)
rather than one shared string — a slow turn on one device no longer queues or times out a turn on
another (a shared lane produced a real 38s wait during the same investigation).

The model is asked to answer as `{"spoken":"..."}` (the same JSON contract the `voice-call`
plugin uses for phone calls) so markdown, tool commentary, and meta-reasoning never reach Piper;
`src/spoken-text.ts` extracts and sanitizes the final text, with a plain-text fallback if the
model doesn't follow the contract.

### Response delivery

The route answers in one of two shapes, chosen by standard content negotiation:

- **Default (no `Accept: text/event-stream`)** — one full JSON body per turn, exactly as before:
  `200 {ok, response, continueConversation, traceId}`, or `502 {ok:false, error, traceId}`.
- **SSE (`Accept: text/event-stream`)** — the spoken answer streams sentence-by-sentence as the
  model generates it, so TTS can start before the full answer exists. Events: `chunk`
  (`{text}`), `reset` (a tool call or rejected retry discarded what streamed so far, so the next
  `chunk` begins a new utterance), and exactly one terminal `done`/`error` carrying the same
  payload the JSON body would have. Because headers flush before generation starts, a failed
  turn is reported by the terminal `error` event — the status code is always `200`.

The terminal event carries the full canonical text as well as the deltas, and **the terminal
payload is the authoritative one** — the deltas can differ, since the batch path trims and
sanitizes in ways a growing prefix cannot. When the model breaks the JSON contract entirely
(a real, measured failure mode) the deltas fall back to raw prose, and stream nothing at all if
that prose opens with meta-reasoning or a code fence, since neither is safe to speak aloud and
neither can be retracted once played.

## Status

Built as the S1.7 spike per
[fairlead-ha's requirements.md](https://github.com/jwhite/fairlead-ha/blob/main/projects/ha-voice/requirements.md).
**Deployed and verified live 2026-07-28** on the real OpenClaw instance (LXC 100) — real
round-trips through MoaBot's actual agent runtime confirmed (`curl .../converse -d
'{"text":"..."}'` → correct spoken response). Not yet wired to a real HA conversation-agent
integration end-to-end — that's the remaining step.

## Deploying as a local (non-monorepo) plugin

This is not published; it's installed the same way `voice-call`'s own README documents for local
dev, with three gotchas that cost real time to find (none are `voice-call`/`webhooks`-specific —
they apply to any plugin dropped into `~/.openclaw/extensions/` outside the monorepo):

1. **The runtime needs compiled JS, not raw TypeScript.** `openclaw.extensions` (pointing at
   `./index.ts`) is only consumed by the monorepo's own dev/type-check tooling. The actual
   running gateway loads whatever `openclaw.runtimeExtensions` points at — this must be compiled
   output (`./dist/index.js`). Build with the included `tsconfig.build.json`:
   `tsc -p extensions/ha-voice/tsconfig.build.json` (mirrors how `repoql`, a real installed
   plugin on the same host, ships `dist/` and declares both fields).
2. **`plugins.allow` is a separate gate from `plugins.entries.<id>.enabled`.** A plugin can be
   fully configured and `enabled: true` and still silently no-op (no error, just absent from the
   "http server listening (N plugins: ...)" boot log and every route 404s) if its id isn't also
   in the top-level `plugins.allow` array. `openclaw plugins list` shows the true status
   (`enabled`/`disabled`) and will say `(not in allowlist)` in config warnings when this is the
   cause.
3. **`activation.onStartup` must be `true`.** An `onConfigPaths`-only activation trigger (no
   `onStartup`) only fires on a _live_ config change while the gateway is already running — not
   on a normal boot where the config already existed beforehand. Both `voice-call` and
   `webhooks` use `onStartup: true`; follow that, not a config-path-only trigger, for anything
   that needs to register an HTTP route.

Deploy steps actually used: copy the plugin folder (minus `node_modules`) into
`/mnt/appdata/openclaw/config/extensions/ha-voice/` on the LXC 100 host (bind-mounted into the
`openclaw` container at `/home/node/.openclaw/extensions/ha-voice/`), `chown` it to uid/gid
`1000:1000` (the container's `node` user — files land as the transferring user otherwise and
`pnpm install` fails with `EACCES`), `docker exec openclaw pnpm install` inside that folder, add
the `plugins.entries.ha-voice` config block and add `"ha-voice"` to `plugins.allow` in the live
`openclaw.json` (back up first), `docker restart openclaw`.
