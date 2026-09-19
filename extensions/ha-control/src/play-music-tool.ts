// Plays music on the configured satellite via Music Assistant's Home Assistant integration.
//
// Two real HA service calls, not one — discovered live (2026-08-03), not assumed from docs:
// `music_assistant.play_media`'s `media_id` field is a required URI (e.g.
// "spotify--xxx://artist/..."), not a free-text search string, despite what an earlier
// web-fetched summary implied. Free-text search resolves through the separate
// `music_assistant.search` service first; its first matching result's `uri` becomes `play_media`'s
// `media_id`. Also: the target entity must be the Music-Assistant-owned media_player entity
// (e.g. `media_player.home_assistant_voice_0aacc1`), not the native ESPHome/Voice-PE entity
// (`..._media_player`) — `play_media`'s target schema only accepts `integration: music_assistant`
// entities; a 400 with no detail is what you get for either mismatch, so both had to be found by
// direct trial against the live HA instance, not guessed. A third gotcha, same story: passing
// `search_options` (e.g. `{limit: 5}`) on the `search` call — a field the schema documents as
// optional with a default — 400s the request anyway. Omit it entirely; the default applies.
import { Type } from "typebox";
import { jsonResult, stringEnum, type AnyAgentTool } from "../api.js";
import { callHomeAssistantService } from "./ha-service-client.js";

const MEDIA_TYPES = ["artist", "album", "track", "playlist", "audiobook", "podcast", "radio"] as const;
export type PlayMusicMediaType = (typeof MEDIA_TYPES)[number];

const SEARCH_RESULT_KEY_BY_MEDIA_TYPE: Record<PlayMusicMediaType, string> = {
  artist: "artists",
  album: "albums",
  track: "tracks",
  playlist: "playlists",
  audiobook: "audiobooks",
  // Music Assistant's SearchResults fields are not uniformly plural: podcasts are "podcasts"
  // but radio is the singular "radio". Verified against music_assistant_models.media_items
  // .SearchResults on the live server (2026-09-19) — guessing "radios" fails silently, since a
  // missing key just yields no results and looks like "nothing matched".
  podcast: "podcasts",
  radio: "radio",
};

export type PlayMusicToolDeps = {
  baseUrl: string;
  // Resolved lazily inside execute(), not eagerly before registration — see index.ts for why:
  // registerTool's factory contract is synchronous, so any async work (secret-ref resolution)
  // must not sit between plugin startup and the tool object being registered.
  resolveToken: () => Promise<string>;
  defaultMediaPlayerEntityId: string;
  musicAssistantConfigEntryId: string;
};

const PlayMusicToolSchema = Type.Object(
  {
    query: Type.String({
      description:
        "What to play — artist, album, song, playlist, audiobook, podcast, or radio station.",
    }),
    media_type: Type.Optional(
      stringEnum(MEDIA_TYPES, {
        description:
          "What kind of thing 'query' names: 'audiobook' for Audible titles, 'podcast' for " +
          "news bulletins and shows (plays the latest episode), 'radio' for live stations. " +
          "Defaults to 'track' if unsure — so ALWAYS set this explicitly for news, bulletins, " +
          "podcasts and radio, or the request resolves to a song with a similar-sounding name.",
      }),
    ),
  },
  { additionalProperties: false },
);

function readMediaType(value: unknown): PlayMusicMediaType {
  return typeof value === "string" && (MEDIA_TYPES as readonly string[]).includes(value)
    ? (value as PlayMusicMediaType)
    : "track";
}

type MusicAssistantSearchResultItem = { uri?: string; name?: string };
type MusicAssistantSearchResponse = Record<string, MusicAssistantSearchResultItem[] | undefined>;

async function resolveMediaUri(
  deps: PlayMusicToolDeps,
  token: string,
  query: string,
  mediaType: PlayMusicMediaType,
): Promise<string | null> {
  const response = (await callHomeAssistantService({
    baseUrl: deps.baseUrl,
    token,
    domain: "music_assistant",
    service: "search",
    returnResponse: true,
    data: {
      config_entry_id: deps.musicAssistantConfigEntryId,
      name: query,
      media_type: [mediaType],
    },
  })) as MusicAssistantSearchResponse | null;

  const key = SEARCH_RESULT_KEY_BY_MEDIA_TYPE[mediaType];
  const results = response?.[key];
  return results?.[0]?.uri ?? null;
}

export function createPlayMusicTool(deps: PlayMusicToolDeps): AnyAgentTool {
  return {
    name: "play_music_on_satellite",
    label: "Play music on the voice satellite",
    description:
      'Starts playback on "Moa Voice Bedroom" via Music Assistant: music, audiobooks, ' +
      "podcasts (news bulletins) or live radio, requested by name. Set media_type to match what " +
      "was asked for — a news/bulletin request is media_type 'podcast', a station is 'radio'. " +
      "Plays immediately, no confirmation needed (low stakes — easily stopped/changed if wrong).",
    parameters: PlayMusicToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = typeof rawParams.query === "string" ? rawParams.query.trim() : "";
      if (!query) {
        return jsonResult({ ok: false, error: "query is required" });
      }
      const mediaType = readMediaType(rawParams.media_type);

      try {
        const token = await deps.resolveToken();
        const mediaUri = await resolveMediaUri(deps, token, query, mediaType);
        if (!mediaUri) {
          return jsonResult({
            ok: false,
            error: `No ${mediaType} match found for "${query}"`,
          });
        }

        await callHomeAssistantService({
          baseUrl: deps.baseUrl,
          token,
          domain: "music_assistant",
          service: "play_media",
          data: {
            entity_id: deps.defaultMediaPlayerEntityId,
            media_id: mediaUri,
            media_type: mediaType,
          },
        });
        return jsonResult({
          ok: true,
          query,
          mediaType,
          mediaUri,
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
