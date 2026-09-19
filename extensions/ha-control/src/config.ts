// ha-control config schema and resolution.
import { z } from "zod";

const secretRefSchema = z
  .object({
    source: z.enum(["env", "file", "exec"]),
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
  })
  .strict();

const tokenInputSchema = z.union([z.string().trim().min(1), secretRefSchema]);

export type HaControlTokenInput = z.infer<typeof tokenInputSchema>;

export const haControlPluginConfigSchema = z
  .object({
    baseUrl: z.string().trim().min(1),
    token: tokenInputSchema,
    defaultMediaPlayerEntityId: z.string().trim().min(1),
    musicAssistantConfigEntryId: z.string().trim().min(1),
    sleepTimerEntityId: z.string().trim().min(1),
    // Optional: only needed by start_my_day. Defaults match the bedroom satellite install.
    assistSatelliteEntityId: z.string().trim().min(1).optional(),
    weatherEntityId: z.string().trim().min(1).optional(),
  })
  .strict();

export type HaControlPluginConfig = z.infer<typeof haControlPluginConfigSchema>;

export type ResolvedHaControlConfig = {
  baseUrl: string;
  token: HaControlTokenInput;
  defaultMediaPlayerEntityId: string;
  musicAssistantConfigEntryId: string;
  sleepTimerEntityId: string;
  assistSatelliteEntityId: string;
  weatherEntityId: string;
};

const DEFAULT_ASSIST_SATELLITE = "assist_satellite.home_assistant_voice_0aacc1_assist_satellite";
const DEFAULT_WEATHER_ENTITY = "weather.forecast_home";

export function resolveHaControlPluginConfig(params: {
  pluginConfig: unknown;
}): ResolvedHaControlConfig {
  const parsed = haControlPluginConfigSchema.parse(params.pluginConfig ?? {});
  return {
    baseUrl: parsed.baseUrl,
    token: parsed.token,
    defaultMediaPlayerEntityId: parsed.defaultMediaPlayerEntityId,
    musicAssistantConfigEntryId: parsed.musicAssistantConfigEntryId,
    sleepTimerEntityId: parsed.sleepTimerEntityId,
    assistSatelliteEntityId: parsed.assistSatelliteEntityId ?? DEFAULT_ASSIST_SATELLITE,
    weatherEntityId: parsed.weatherEntityId ?? DEFAULT_WEATHER_ENTITY,
  };
}
