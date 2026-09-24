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
import { fetchNewestEpisode, matchKnownFeed } from "./podcast-feeds.js";

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

/** Splits "TITLE by ARTIST" on the LAST " by ".
 *
 * Last, not first, because titles containing "by" are common — "By the Way by Red Hot Chili
 * Peppers", "Stand By Me by Ben E. King". Splitting on the first occurrence mangles both.
 *
 * This is only ever a *hypothesis*: "Stand By Me" with no artist at all splits into
 * "Stand" + "Me", which is nonsense. That is why the caller tries the whole string too and
 * validates before playing anything. */
function splitTitleAndArtist(query: string): { title: string; artist: string } | null {
  const match = /^(.*\S)\s+by\s+(\S.*)$/i.exec(query);
  if (!match) {
    return null;
  }
  const title = match[1]?.trim() ?? "";
  const artist = match[2]?.trim() ?? "";
  return title && artist ? { title, artist } : null;
}

/** Lowercase, strip accents and punctuation, collapse whitespace — so "Death Cab For Cutie"
 * and "death cab for cutie" compare equal, and "L.A.B." reduces to "lab". */
function normalise(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const IGNORED_TOKENS = new Set(["the", "a", "an", "of", "and", "for", "by", "in", "on", "to"]);

function significantTokens(value: string): string[] {
  return normalise(value)
    .split(" ")
    .filter((t) => t.length >= 2 && !IGNORED_TOKENS.has(t));
}

/** Does `candidate` plausibly answer `wanted`?
 *
 * Deliberately lenient — every significant token of the shorter side must appear in the other, so
 * "Beatles" matches "The Beatles" and a punctuation difference never rejects a correct hit. What it
 * does reject is a result sharing no meaningful word with the request, which is exactly the failure
 * this exists to stop: asking for Death Cab for Cutie and being given L.A.B. */
function plausibleMatch(candidate: string, wanted: string): boolean {
  const wantedTokens = significantTokens(wanted);
  const candidateTokens = new Set(significantTokens(candidate));
  if (wantedTokens.length === 0 || candidateTokens.size === 0) {
    return false;
  }
  const overlap = wantedTokens.filter((t) => candidateTokens.has(t)).length;
  // One shared token is enough for a single-word request; longer requests need most of theirs.
  return wantedTokens.length <= 2 ? overlap >= 1 : overlap >= Math.ceil(wantedTokens.length * 0.6);
}

type SearchAttempt = {
  /** What goes in Music Assistant's `name` field. */
  name: string;
  /** Music Assistant has a dedicated `artist` field; using it is what fixes the combined query. */
  artist?: string;
  /** What the result has to resemble to be accepted. */
  expectTitle: string;
  expectArtist?: string;
};

export type ResolvedMedia = { uri: string | null; nearest?: string };

/** Resolves a spoken request to a playable URI, or to nothing with the nearest miss named.
 *
 * **Why this is more than one search.** Music Assistant cannot parse "TITLE by ARTIST" — it treats
 * the whole string as a title. Measured 2026-09-24 against this library:
 *
 *   "I Built You A Tower by Death Cab for Cutie"  -> L.A.B III by L.A.B.            (wrong)
 *   "I Built You A Tower" + artist "Death Cab..." -> I Built You A Tower            (right)
 *   "I Built You A Tower"                          -> I Built You A Tower            (right)
 *
 * The album was in the library the whole time; only the phrasing failed. The previous
 * implementation took `results[0].uri` with no check, so that wrong album played with no warning —
 * the worst outcome, because the listener cannot tell what happened or why.
 *
 * So: try the split hypothesis using MA's real `artist` field, fall back to the whole string (which
 * is what rescues "Stand By Me", where the split is nonsense), and **validate before returning**.
 * A result that resembles nothing that was asked for is reported as a miss, not played. */
async function resolveMediaUri(
  deps: PlayMusicToolDeps,
  token: string,
  query: string,
  mediaType: PlayMusicMediaType,
): Promise<ResolvedMedia> {
  const split = splitTitleAndArtist(query);
  const attempts: SearchAttempt[] = [];
  if (split) {
    attempts.push({
      name: split.title,
      artist: split.artist,
      expectTitle: split.title,
      expectArtist: split.artist,
    });
  }
  attempts.push({ name: query, expectTitle: query });

  const key = SEARCH_RESULT_KEY_BY_MEDIA_TYPE[mediaType];
  let nearest: string | undefined;

  for (const attempt of attempts) {
    const response = (await callHomeAssistantService({
      baseUrl: deps.baseUrl,
      token,
      domain: "music_assistant",
      service: "search",
      returnResponse: true,
      data: {
        config_entry_id: deps.musicAssistantConfigEntryId,
        name: attempt.name,
        ...(attempt.artist ? { artist: attempt.artist } : {}),
        media_type: [mediaType],
      },
    })) as MusicAssistantSearchResponse | null;

    const results = response?.[key] ?? [];
    for (const result of results) {
      const uri = (result as { uri?: string })?.uri;
      if (!uri) {
        continue;
      }
      const name = (result as { name?: string })?.name ?? "";
      const artists = ((result as { artists?: { name?: string }[] })?.artists ?? [])
        .map((a) => a?.name ?? "")
        .join(" ");
      const describe = artists ? `${name} — ${artists}` : name;
      nearest ??= describe;

      const titleOk = plausibleMatch(name, attempt.expectTitle);
      const artistOk = attempt.expectArtist
        ? plausibleMatch(artists, attempt.expectArtist)
        : true;
      // An artist-only request ("play Death Cab for Cutie") matches on the artist instead.
      const artistAnsweredTheTitle =
        !attempt.expectArtist && plausibleMatch(artists, attempt.expectTitle);

      if ((titleOk || artistAnsweredTheTitle) && artistOk) {
        return { uri };
      }
    }
  }

  // Something came back, but nothing resembling the request. Say so rather than playing it:
  // the caller turns this into "I couldn't find X", which is what the listener needs to hear.
  return { uri: null, nearest };
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

        // Known news feeds bypass Music Assistant entirely: MA serves a feed cached for up to 24h,
        // and playing a *podcast* enqueues its whole episode list, so "play the RNZ bulletin" ends
        // up working backwards through stale bulletins. Resolving the feed here gives exactly one
        // current episode. Unknown podcasts still fall through to MA search below.
        if (mediaType === "podcast") {
          const feed = matchKnownFeed(query);
          if (feed) {
            const episode = await fetchNewestEpisode(feed.url);
            if (!episode) {
              return jsonResult({
                ok: false,
                error: `No episode found in the ${feed.label} feed for "${query}"`,
              });
            }
            await callHomeAssistantService({
              baseUrl: deps.baseUrl,
              token,
              domain: "music_assistant",
              service: "play_media",
              data: {
                entity_id: deps.defaultMediaPlayerEntityId,
                media_id: episode.url,
                enqueue: "replace",
              },
            });
            return jsonResult({
              ok: true,
              query,
              mediaType,
              source: feed.label,
              title: episode.title,
              published: episode.published?.toISOString(),
              singleEpisode: true,
              entityId: deps.defaultMediaPlayerEntityId,
            });
          }
        }

        const resolved = await resolveMediaUri(deps, token, query, mediaType);
        const mediaUri = resolved.uri;
        if (!mediaUri) {
          // `nearest` is what the search did return. Handing it back lets the assistant say
          // "I couldn't find X — I found Y, want that?" instead of silently playing Y, which is
          // the failure this whole path exists to prevent (2026-09-24: asked for Death Cab for
          // Cutie, played L.A.B., said nothing).
          return jsonResult({
            ok: false,
            error: `No ${mediaType} match found for "${query}"`,
            ...(resolved.nearest ? { nearest: resolved.nearest } : {}),
            tellTheUser: resolved.nearest
              ? `Say that you could not find "${query}" and name what you found instead: ${resolved.nearest}. Do not play it without asking.`
              : `Say that you could not find "${query}".`,
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
