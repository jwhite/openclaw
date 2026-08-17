// Stops, pauses, or resumes whatever is playing on the configured satellite.
//
// Core HA media_player services (media_stop/media_pause/media_play), not Music Assistant's custom
// ones, so none of play-music-tool.ts's Music Assistant-specific gotchas apply — but the target is
// still the Music-Assistant-owned entity (`media_player.home_assistant_voice_0aacc1`), the same
// one play_music_on_satellite starts playback on, so stopping addresses the queue that was
// actually started rather than the native ESPHome entity's separate media surface.
import { Type } from "typebox";
import { jsonResult, stringEnum, type AnyAgentTool } from "../api.js";
import { callHomeAssistantService } from "./ha-service-client.js";

const PLAYBACK_ACTIONS = ["stop", "pause", "resume"] as const;
export type PlaybackAction = (typeof PLAYBACK_ACTIONS)[number];

// Voice users reach for all three interchangeably ("stop it", "pause", "keep going"), and they are
// one HA domain apart in name only, so one tool with an action beats three near-identical tools.
const SERVICE_BY_ACTION: Record<PlaybackAction, string> = {
  stop: "media_stop",
  pause: "media_pause",
  resume: "media_play",
};

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
        "'stop' to end playback and clear it, 'pause' to hold the current position, " +
        "'resume' to continue a paused track.",
    }),
  },
  { additionalProperties: false },
);

function readAction(value: unknown): PlaybackAction | null {
  return typeof value === "string" && (PLAYBACK_ACTIONS as readonly string[]).includes(value)
    ? (value as PlaybackAction)
    : null;
}

export function createPlaybackControlTool(deps: PlaybackControlToolDeps): AnyAgentTool {
  return {
    name: "control_satellite_playback",
    label: "Stop, pause, or resume playback on the voice satellite",
    description:
      'Stops, pauses, or resumes music or an audiobook already playing on "Moa Voice Bedroom" — ' +
      'use this for "stop the music", "pause", or "keep playing". Takes effect immediately, no ' +
      "confirmation needed (low stakes — easily restarted).",
    parameters: PlaybackControlToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readAction(rawParams.action);
      if (!action) {
        return jsonResult({ ok: false, error: "action must be 'stop', 'pause', or 'resume'" });
      }

      try {
        const token = await deps.resolveToken();
        await callHomeAssistantService({
          baseUrl: deps.baseUrl,
          token,
          domain: "media_player",
          service: SERVICE_BY_ACTION[action],
          data: { entity_id: deps.defaultMediaPlayerEntityId },
        });
        return jsonResult({
          ok: true,
          action,
          entityId: deps.defaultMediaPlayerEntityId,
        });
      } catch (err) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
