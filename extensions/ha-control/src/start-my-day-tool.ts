// The "start my day" morning routine: spoken weather, then the RNZ and NPR news bulletins.
//
// Why this is one tool rather than the model orchestrating three calls:
//
// 1. ORDERING. The agent's spoken text is emitted at the *end* of a turn, but tool calls run
//    *during* it. So if the model started a podcast and then spoke the weather, the bulletin would
//    already be playing underneath the speech. Doing announce-then-play inside one tool is the
//    only way to get weather *then* news. NOTE: `assist_satellite.announce` does NOT block until
//    the speech finishes (assumed initially; the weather was heard *over* the first bulletin), so
//    the tool polls the satellite entity back to idle before starting playback.
//
// 2. FRESHNESS. Music Assistant caches a parsed podcast feed for 24h
//    (`PODCAST_FEED_CACHE_EXPIRATION = 24 * 3600`), and only refreshes it on a library sync — which
//    Home Assistant exposes no service for. Playing the *podcast* therefore serves whatever was
//    newest when the cache was filled: observed 2026-09-19 playing "RNZ News at 12pm, September 18"
//    when the feed's newest was "7am, September 19", an episode that had already rolled off the
//    feed entirely (RNZ keeps only 3). A morning routine that reads yesterday's news is broken, so
//    we read each RSS feed ourselves and play the newest enclosure URL directly. MA maps a plain
//    URL onto its `builtin` provider (see helpers/uri.py BUILTIN_URL_SCHEMES), so a direct episode
//    URL is a valid `media_id`.
//
// 3. STALENESS IS SPOKEN, NOT HIDDEN. RNZ publishes 4x daily (7am/12pm/5pm/10pm), so "newest" can
//    still be last night's. The announcement says how old the bulletin is when it is not recent,
//    rather than letting old news pass as current.
import { Type } from "typebox";
import { jsonResult, type AnyAgentTool } from "../api.js";
import { callHomeAssistantService } from "./ha-service-client.js";
import {
  describeAge,
  fetchNewestEpisode,
  KNOWN_FEEDS,
  type Episode,
} from "./podcast-feeds.js";

export type StartMyDayToolDeps = {
  baseUrl: string;
  resolveToken: () => Promise<string>;
  defaultMediaPlayerEntityId: string;
  assistSatelliteEntityId: string;
  weatherEntityId: string;
};

const StartMyDayToolSchema = Type.Object({}, { additionalProperties: false });

type HassState = { state?: string; attributes?: Record<string, unknown> };

async function getState(
  deps: StartMyDayToolDeps,
  token: string,
  entityId: string,
): Promise<HassState | null> {
  const response = await fetch(
    `${deps.baseUrl.replace(/\/+$/, "")}/api/states/${encodeURIComponent(entityId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as HassState;
}

/** Waits for the satellite to finish speaking an announcement.
 *
 * `assist_satellite.announce` does NOT block until the speech finishes — it returns as soon as the
 * announcement is accepted (confirmed live 2026-09-19: the weather was spoken *over* the first
 * bulletin). The satellite entity moves to a non-idle state ("responding"/"announcing") while it
 * talks, so we poll it back to idle before starting playback.
 *
 * Tolerates both orderings: if the announcement has not started yet we wait for it to begin
 * (up to `settleMs`), and if it never leaves idle we simply proceed rather than hanging. */
async function waitForAnnouncementToFinish(
  deps: StartMyDayToolDeps,
  token: string,
  opts: { timeoutMs: number; settleMs: number },
): Promise<"finished" | "never-started" | "timeout"> {
  const started = Date.now();
  let sawSpeaking = false;
  while (Date.now() - started < opts.timeoutMs) {
    const state = (await getState(deps, token, deps.assistSatelliteEntityId))?.state;
    const speaking = state !== undefined && state !== "idle" && state !== "unavailable";
    if (speaking) {
      sawSpeaking = true;
    } else if (sawSpeaking) {
      return "finished";
    } else if (Date.now() - started > opts.settleMs) {
      // Never observed it speaking — either the announcement was synchronous after all, or the
      // entity doesn't reflect it. Either way, don't hold the routine up.
      return "never-started";
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return "timeout";
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value: number): number {
  return Math.round(value);
}

/** Turns a HA weather condition slug ("partlycloudy") into something a TTS voice reads naturally. */
function humanCondition(condition: string | undefined): string {
  if (!condition) {
    return "unclear";
  }
  const map: Record<string, string> = {
    "clear-night": "clear",
    cloudy: "cloudy",
    exceptional: "extreme",
    fog: "foggy",
    hail: "hailing",
    lightning: "thundery",
    "lightning-rainy": "thundery showers",
    partlycloudy: "partly cloudy",
    pouring: "pouring with rain",
    rainy: "rainy",
    snowy: "snowy",
    "snowy-rainy": "sleety",
    sunny: "sunny",
    windy: "windy",
    "windy-variant": "windy",
  };
  return map[condition] ?? condition.replace(/[-_]/g, " ");
}

async function buildWeatherSentence(deps: StartMyDayToolDeps, token: string): Promise<string> {
  const current = await getState(deps, token, deps.weatherEntityId);
  if (!current) {
    return "I couldn't read the weather right now.";
  }
  const attrs = current.attributes ?? {};
  const parts: string[] = [];
  const temp = num(attrs.temperature);
  parts.push(
    `Right now it's ${humanCondition(current.state)}${temp === null ? "" : ` and ${round(temp)} degrees`}.`,
  );

  const wind = num(attrs.wind_speed);
  const humidity = num(attrs.humidity);
  const detail: string[] = [];
  if (wind !== null) {
    detail.push(`wind ${round(wind)} k m h`);
  }
  if (humidity !== null) {
    detail.push(`humidity ${round(humidity)} percent`);
  }
  if (detail.length > 0) {
    parts.push(`${detail.join(", ")}.`);
  }

  // Daily forecast is a separate service call returning a response payload.
  try {
    const forecastResponse = (await callHomeAssistantService({
      baseUrl: deps.baseUrl,
      token,
      domain: "weather",
      service: "get_forecasts",
      returnResponse: true,
      data: { entity_id: deps.weatherEntityId, type: "daily" },
    })) as Record<string, { forecast?: Array<Record<string, unknown>> }> | null;
    const today = forecastResponse?.[deps.weatherEntityId]?.forecast?.[0];
    if (today) {
      const high = num(today.temperature);
      const low = num(today.templow);
      const cond = humanCondition(typeof today.condition === "string" ? today.condition : undefined);
      const rangeBits: string[] = [];
      if (high !== null) {
        rangeBits.push(`a high of ${round(high)}`);
      }
      if (low !== null) {
        rangeBits.push(`a low of ${round(low)}`);
      }
      parts.push(
        `Today: ${cond}${rangeBits.length > 0 ? `, ${rangeBits.join(" and ")}` : ""}.`,
      );
      const rain = num(today.precipitation);
      if (rain !== null && rain > 0) {
        parts.push(`${rain} millimetres of rain expected.`);
      }
    }
  } catch {
    // A missing forecast is not worth failing the whole routine over — the current
    // conditions above are still useful, so carry on with what we have.
  }
  return parts.join(" ");
}

export function createStartMyDayTool(deps: StartMyDayToolDeps): AnyAgentTool {
  return {
    name: "start_my_day",
    label: "Start my day (weather then news bulletins)",
    description:
      'The morning routine for "Moa Voice Bedroom", triggered by "start my day" or similar ' +
      "(good morning / my morning briefing / the daily briefing). Speaks the current weather and " +
      "today's outlook, then plays the latest RNZ news bulletin followed by the latest NPR News " +
      "Now bulletin, back to back. Handles the whole sequence itself — do NOT also call " +
      "play_music_on_satellite, and do not speak a summary afterwards: the weather is spoken by " +
      "this tool and the bulletins are their own confirmation.",
    parameters: StartMyDayToolSchema,
    execute: async () => {
      try {
        const token = await deps.resolveToken();
        const now = new Date();

        // Resolve the episodes BEFORE speaking, so the announcement can mention a stale bulletin
        // and so a feed failure doesn't strand us having already spoken.
        const episodes: Array<{ label: string; episode: Episode | null; error?: string }> = [];
        for (const feed of KNOWN_FEEDS) {
          try {
            episodes.push({ label: feed.label, episode: await fetchNewestEpisode(feed.url) });
          } catch (err) {
            episodes.push({
              label: feed.label,
              episode: null,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const playable = episodes.filter(
          (e): e is { label: string; episode: Episode } => e.episode !== null,
        );

        const weather = await buildWeatherSentence(deps, token);
        const notes: string[] = [];
        for (const { label, episode } of playable) {
          const age = describeAge(episode.published, now);
          if (age) {
            notes.push(`The latest ${label} bulletin is ${age}.`);
          }
        }
        const missing = episodes.filter((e) => e.episode === null).map((e) => e.label);
        if (missing.length > 0) {
          notes.push(`I couldn't reach the ${missing.join(" or ")} feed.`);
        }

        const message = [
          "Good morning.",
          weather,
          ...notes,
          playable.length > 0 ? "Here's the news." : "",
        ]
          .filter(Boolean)
          .join(" ");

        await callHomeAssistantService({
          baseUrl: deps.baseUrl,
          token,
          domain: "assist_satellite",
          service: "announce",
          data: { entity_id: deps.assistSatelliteEntityId, message },
        });
        // The service call returns before the speech does, so wait for the satellite to go quiet.
        // Without this the first bulletin starts underneath the weather report.
        const announceOutcome = await waitForAnnouncementToFinish(deps, token, {
          timeoutMs: 120_000,
          settleMs: 6_000,
        });

        for (const [index, { episode }] of playable.entries()) {
          await callHomeAssistantService({
            baseUrl: deps.baseUrl,
            token,
            domain: "music_assistant",
            service: "play_media",
            data: {
              entity_id: deps.defaultMediaPlayerEntityId,
              media_id: episode.url,
              // First item replaces whatever was playing; the rest queue behind it so the
              // bulletins run back to back without a second spoken prompt.
              enqueue: index === 0 ? "replace" : "add",
            },
          });
        }

        return jsonResult({
          ok: true,
          spokenWeather: message,
          announceOutcome,
          played: playable.map(({ label, episode }) => ({
            source: label,
            title: episode.title,
            published: episode.published?.toISOString(),
            url: episode.url,
          })),
          failed: episodes
            .filter((e) => e.episode === null)
            .map((e) => ({ source: e.label, error: e.error ?? "no enclosure in feed" })),
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
