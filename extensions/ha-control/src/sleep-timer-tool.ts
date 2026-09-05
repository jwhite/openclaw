// Starts/cancels the sleep timer via HA's standard timer.start/timer.cancel services against the
// timer.sleep_timer helper (configuration.yaml, restore: true) — a separate HA automation
// (sleep_timer_pause_playback) handles the actual timer.finished -> media_player.media_pause step;
// this tool only starts/cancels the countdown, it doesn't touch playback directly.
import { Type } from "typebox";
import { jsonResult, stringEnum, type AnyAgentTool } from "../api.js";
import { callHomeAssistantService } from "./ha-service-client.js";

const SLEEP_TIMER_ACTIONS = ["start", "cancel"] as const;
export type SleepTimerAction = (typeof SLEEP_TIMER_ACTIONS)[number];

export type SleepTimerToolDeps = {
  baseUrl: string;
  // Resolved lazily inside execute(), not eagerly before registration — see index.ts: registerTool's
  // factory contract is synchronous, so async token resolution must never sit between plugin
  // startup and the tool object being registered.
  resolveToken: () => Promise<string>;
  timerEntityId: string;
};

const SleepTimerToolSchema = Type.Object(
  {
    action: stringEnum(SLEEP_TIMER_ACTIONS, {
      description: "'start' begins the countdown (requires minutes), 'cancel' stops it early.",
    }),
    minutes: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 480,
        description: "How many minutes until playback pauses. Required when action is 'start'.",
      }),
    ),
  },
  { additionalProperties: false },
);

function readAction(value: unknown): SleepTimerAction | null {
  return typeof value === "string" && (SLEEP_TIMER_ACTIONS as readonly string[]).includes(value)
    ? (value as SleepTimerAction)
    : null;
}

function formatDuration(minutes: number): string {
  const totalSeconds = Math.round(minutes * 60);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

export function createSleepTimerTool(deps: SleepTimerToolDeps): AnyAgentTool {
  return {
    name: "set_sleep_timer",
    label: "Set a sleep timer for the voice satellite",
    description:
      'Starts or cancels a sleep timer that pauses playback on "Moa Voice Bedroom" after a ' +
      "chosen number of minutes (a separate automation handles the actual pause when the timer " +
      "finishes). Plays immediately, no confirmation needed.",
    parameters: SleepTimerToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readAction(rawParams.action);
      if (!action) {
        return jsonResult({ ok: false, error: "action must be 'start' or 'cancel'" });
      }
      if (action === "start" && typeof rawParams.minutes !== "number") {
        return jsonResult({
          ok: false,
          error: "minutes is required when action is 'start'",
        });
      }

      try {
        const token = await deps.resolveToken();
        const data: Record<string, unknown> = { entity_id: deps.timerEntityId };
        if (action === "start") {
          data.duration = formatDuration(rawParams.minutes as number);
        }

        await callHomeAssistantService({
          baseUrl: deps.baseUrl,
          token,
          domain: "timer",
          service: action === "start" ? "start" : "cancel",
          data,
        });
        return jsonResult({
          ok: true,
          action,
          ...(action === "start" ? { minutes: rawParams.minutes } : {}),
          entityId: deps.timerEntityId,
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
