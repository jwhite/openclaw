// Stops, pauses, resumes, or skips within whatever is playing on the configured satellite.
//
// stop/pause/resume use core HA media_player services (media_stop/media_pause/media_play), not Music
// Assistant's custom ones, so none of play-music-tool.ts's Music Assistant-specific gotchas apply —
// but the target is still the Music-Assistant-owned entity (`media_player.home_assistant_voice_0aacc1`),
// the same one play_music_on_satellite starts playback on, so stopping addresses the queue that was
// actually started rather than the native ESPHome entity's separate media surface.
//
// forward/back are relative seeks. Their base position comes from Music Assistant's queue
// (`music_assistant.get_queue` → `elapsed_time`), NEVER Home Assistant's `media_position` attribute:
// HA reports 0 (or badly lagged) for Music-Assistant-provided players while playback and progress are
// correct, so a seek computed from `media_position` would jump the book toward the start. See the
// audiobook-playback decision record in fairlead-ops.
import { Type } from "typebox";
import { jsonResult, stringEnum, type AnyAgentTool } from "../api.js";
import { callHomeAssistantService } from "./ha-service-client.js";

const PLAYBACK_ACTIONS = ["stop", "pause", "resume", "forward", "back"] as const;
export type PlaybackAction = (typeof PLAYBACK_ACTIONS)[number];

// Simple actions map straight to a core media_player service with no position math.
const SERVICE_BY_SIMPLE_ACTION = {
  stop: "media_stop",
  pause: "media_pause",
  resume: "media_play",
} as const;
type SimpleAction = keyof typeof SERVICE_BY_SIMPLE_ACTION;

const DEFAULT_SKIP_SECONDS = 30;
const MAX_SKIP_SECONDS = 86_400;

export type PlaybackControlToolDeps = {
  baseUrl: string;
  // Resolved lazily inside execute(), not eagerly before registration — see index.ts: registerTool's
  // factory contract is synchronous, so async token resolution must never sit between plugin
  // startup and the tool object being registered.
  resolveToken: () => Promise<string>;
  defaultMediaPlayerEntityId: string;
};

const PlaybackControlToolSchema = Type.Object(
  {
    action: stringEnum(PLAYBACK_ACTIONS, {
      description:
        "'stop' ends playback; 'pause' holds the current position; 'resume' continues. " +
        "'forward' skips ahead / fast-forwards; 'back' skips back / rewinds. Map 'rewind', " +
        "'go back', 'skip back', or 'back up' to 'back'; map 'fast forward', 'skip ahead', or " +
        "'jump ahead' to 'forward'.",
    }),
    seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "For 'forward'/'back': how many seconds to skip, converting any spoken duration to " +
          "seconds (\"two minutes\" = 120, \"a minute and a half\" = 90, \"ten seconds\" = 10). " +
          "Defaults to 30 when omitted.",
      }),
    ),
  },
  { additionalProperties: false },
);

function readAction(value: unknown): PlaybackAction | null {
  return typeof value === "string" && (PLAYBACK_ACTIONS as readonly string[]).includes(value)
    ? (value as PlaybackAction)
    : null;
}

function isSimpleAction(action: PlaybackAction): action is SimpleAction {
  return action in SERVICE_BY_SIMPLE_ACTION;
}

function readSkipSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_SKIP_SECONDS;
  }
  return Math.min(Math.floor(n), MAX_SKIP_SECONDS);
}

// Authoritative playback position for the satellite's active queue, read from Music Assistant rather
// than the unreliable HA `media_position`. Returns null when nothing is playing (no queue to seek).
async function readActiveQueuePosition(
  deps: PlaybackControlToolDeps,
  token: string,
): Promise<{ elapsedSeconds: number; durationSeconds?: number } | null> {
  const response = await callHomeAssistantService({
    baseUrl: deps.baseUrl,
    token,
    domain: "music_assistant",
    service: "get_queue",
    data: { entity_id: deps.defaultMediaPlayerEntityId },
    returnResponse: true,
  });
  if (!response || typeof response !== "object") {
    return null;
  }
  // get_queue returns an object keyed by queue id; the entity target scopes it to this one player.
  const queue = Object.values(response as Record<string, unknown>).find(
    (value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && "elapsed_time" in (value as object),
  );
  if (!queue) {
    return null;
  }
  const elapsedSeconds = Number(queue.elapsed_time);
  if (!Number.isFinite(elapsedSeconds)) {
    return null;
  }
  const currentItem = queue.current_item;
  const rawDuration =
    currentItem && typeof currentItem === "object"
      ? Number((currentItem as Record<string, unknown>).duration)
      : Number.NaN;
  return {
    elapsedSeconds,
    ...(Number.isFinite(rawDuration) ? { durationSeconds: rawDuration } : {}),
  };
}

// Clamp a seek target into the playable range. The high clamp stops one second short of the end so a
// skip past the end resumes near the finish rather than tripping Audiobookshelf's finished state.
function clampSeekTarget(target: number, durationSeconds?: number): number {
  const floored = Math.max(0, target);
  if (durationSeconds === undefined) {
    return floored;
  }
  return Math.min(floored, Math.max(0, durationSeconds - 1));
}

export function createPlaybackControlTool(deps: PlaybackControlToolDeps): AnyAgentTool {
  return {
    name: "control_satellite_playback",
    label: "Stop, pause, resume, or skip playback on the voice satellite",
    description:
      'Controls music or an audiobook already playing on "Moa Voice Bedroom": stop, pause, resume, ' +
      "fast-forward, or rewind. Use it for any of: \"stop the music\", \"pause\", \"keep playing\", " +
      '"skip ahead", "fast forward two minutes", "go back thirty seconds", "rewind", "skip back", or ' +
      '"back up a bit". Skips are relative to the current position and take effect immediately ' +
      "(low stakes — easily undone).",
    parameters: PlaybackControlToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readAction(rawParams.action);
      if (!action) {
        return jsonResult({
          ok: false,
          error: `action must be one of: ${PLAYBACK_ACTIONS.join(", ")}`,
        });
      }

      try {
        const token = await deps.resolveToken();

        if (isSimpleAction(action)) {
          await callHomeAssistantService({
            baseUrl: deps.baseUrl,
            token,
            domain: "media_player",
            service: SERVICE_BY_SIMPLE_ACTION[action],
            data: { entity_id: deps.defaultMediaPlayerEntityId },
          });
          return jsonResult({ ok: true, action, entityId: deps.defaultMediaPlayerEntityId });
        }

        // forward | back: relative seek from Music Assistant's authoritative position.
        const seconds = readSkipSeconds(rawParams.seconds);
        const position = await readActiveQueuePosition(deps, token);
        if (!position) {
          return jsonResult({ ok: false, action, error: "nothing is playing to skip within" });
        }
        const signedDelta = action === "forward" ? seconds : -seconds;
        const target = clampSeekTarget(position.elapsedSeconds + signedDelta, position.durationSeconds);
        await callHomeAssistantService({
          baseUrl: deps.baseUrl,
          token,
          domain: "media_player",
          service: "media_seek",
          data: { entity_id: deps.defaultMediaPlayerEntityId, seek_position: target },
        });
        return jsonResult({
          ok: true,
          action,
          seconds,
          fromSeconds: Math.round(position.elapsedSeconds),
          toSeconds: Math.round(target),
          entityId: deps.defaultMediaPlayerEntityId,
        });
      } catch (err) {
        return jsonResult({
          ok: false,
          action,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
