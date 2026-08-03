// Adjusts playback volume on the configured satellite via HA's standard media_player services —
// these are core HA services (volume_set/volume_up/volume_down), not Music Assistant's custom
// ones, so none of play-music-tool.ts's Music Assistant-specific gotchas apply here.
import { Type } from "typebox";
import { jsonResult, stringEnum, type AnyAgentTool } from "../api.js";
import { callHomeAssistantService } from "./ha-service-client.js";

const VOLUME_ACTIONS = ["set", "up", "down"] as const;
export type VolumeAction = (typeof VOLUME_ACTIONS)[number];

export type VolumeToolDeps = {
  baseUrl: string;
  // Resolved lazily inside execute(), not eagerly before registration — see index.ts: registerTool's
  // factory contract is synchronous, so async token resolution must never sit between plugin
  // startup and the tool object being registered.
  resolveToken: () => Promise<string>;
  defaultMediaPlayerEntityId: string;
};

const VolumeToolSchema = Type.Object(
  {
    action: stringEnum(VOLUME_ACTIONS, {
      description:
        "'set' for an absolute volume (requires level), 'up'/'down' for a relative step.",
    }),
    level: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 100,
        description: "Absolute volume percentage (0-100). Required when action is 'set'.",
      }),
    ),
  },
  { additionalProperties: false },
);

function readAction(value: unknown): VolumeAction | null {
  return typeof value === "string" && (VOLUME_ACTIONS as readonly string[]).includes(value)
    ? (value as VolumeAction)
    : null;
}

export function createVolumeTool(deps: VolumeToolDeps): AnyAgentTool {
  return {
    name: "set_satellite_volume",
    label: "Adjust volume on the voice satellite",
    description:
      'Adjusts playback volume on "Moa Voice Bedroom" — set an absolute level (0-100%) or step ' +
      "it up/down. Plays immediately, no confirmation needed.",
    parameters: VolumeToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readAction(rawParams.action);
      if (!action) {
        return jsonResult({ ok: false, error: "action must be 'set', 'up', or 'down'" });
      }
      if (action === "set" && typeof rawParams.level !== "number") {
        return jsonResult({ ok: false, error: "level (0-100) is required when action is 'set'" });
      }

      try {
        const token = await deps.resolveToken();
        const service = action === "set" ? "volume_set" : `volume_${action}`;
        const data: Record<string, unknown> = { entity_id: deps.defaultMediaPlayerEntityId };
        if (action === "set") {
          data.volume_level = (rawParams.level as number) / 100;
        }

        await callHomeAssistantService({
          baseUrl: deps.baseUrl,
          token,
          domain: "media_player",
          service,
          data,
        });
        return jsonResult({
          ok: true,
          action,
          ...(action === "set" ? { level: rawParams.level } : {}),
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
