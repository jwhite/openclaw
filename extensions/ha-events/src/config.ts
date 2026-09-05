// ha-events config schema and resolution.
import { z } from "zod";

const secretRefSchema = z
  .object({
    source: z.enum(["env", "file", "exec"]),
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
  })
  .strict();

const tokenInputSchema = z.union([z.string().trim().min(1), secretRefSchema]);

export type HaEventsTokenInput = z.infer<typeof tokenInputSchema>;

export const haEventsPluginConfigSchema = z
  .object({
    url: z.string().trim().min(1),
    token: tokenInputSchema,
    /** Optional allow-list of entity domains ("light", "switch", ...); unset = track everything. */
    domains: z.array(z.string().trim().min(1)).optional(),
    maxTrackedEvents: z.number().int().positive().max(500).optional().default(50),
  })
  .strict();

export type HaEventsPluginConfig = z.infer<typeof haEventsPluginConfigSchema>;

export type ResolvedHaEventsConfig = {
  url: string;
  token: HaEventsTokenInput;
  domains?: string[];
  maxTrackedEvents: number;
};

export function resolveHaEventsPluginConfig(params: {
  pluginConfig: unknown;
}): ResolvedHaEventsConfig {
  const parsed = haEventsPluginConfigSchema.parse(params.pluginConfig ?? {});
  return {
    url: parsed.url,
    token: parsed.token,
    ...(parsed.domains ? { domains: parsed.domains } : {}),
    maxTrackedEvents: parsed.maxTrackedEvents,
  };
}
