// Known podcast feeds, resolved straight from RSS rather than through Music Assistant.
//
// Two MA behaviours make this necessary for news bulletins:
//
// 1. STALE. MA caches a parsed feed for 24h (`PODCAST_FEED_CACHE_EXPIRATION = 24 * 3600`) and only
//    refreshes it on a library sync, which Home Assistant exposes no service for. Observed
//    2026-09-19: playing the RNZ podcast served "RNZ News at 12pm, September 18" while the feed's
//    newest was "7am, September 19" — an episode that had already rolled off the feed entirely.
//
// 2. THE WHOLE BACKLOG QUEUES. Playing a *podcast* enqueues its episode list, so one request for
//    "the RNZ bulletin" queued 4 cached episodes and played progressively older news
//    (12pm Sep 18, then 5pm Sep 18, ...) until stopped. MA's search cannot return individual
//    episodes (no `podcast_episode` key in the search response), so the only way to play exactly
//    one current episode is to read the feed ourselves and play that episode's URL.
//
// MA maps a plain URL onto its `builtin` provider (helpers/uri.py, BUILTIN_URL_SCHEMES), so an
// episode URL is a valid `media_id`.

export type KnownFeed = {
  /** Spoken name used in confirmations and staleness notes. */
  label: string;
  url: string;
  /** Lowercase substrings that should resolve to this feed.
   *
   * Speech-to-text mangles spoken acronyms badly: "RNZ" has been transcribed "R&Z", "RADZ" and
   * "RNC" in real turns. Matching on these variants is deliberate — the alternative is a news
   * request falling through to a music search. */
  aliases: readonly string[];
};

export const KNOWN_FEEDS: readonly KnownFeed[] = [
  {
    label: "RNZ",
    url: "https://www.rnz.co.nz/podcasts/news-bulletin-podcast.rss",
    aliases: [
      "rnz",
      "r&z",
      "r and z",
      "radz",
      "rnc",
      "ann z",
      "arenzee",
      "radio new zealand",
      "nz news",
      "new zealand news",
    ],
  },
  {
    label: "NPR",
    url: "https://feeds.npr.org/500005/podcast.xml",
    aliases: ["npr", "n p r", "news now", "national public radio"],
  },
];

/** Resolves a spoken query to a known feed, or null to fall back to Music Assistant search.
 *
 * A bare "the bulletin"/"the news" is intentionally NOT matched here — it is ambiguous between
 * sources, and guessing silently is the failure mode this whole change exists to remove. */
export function matchKnownFeed(query: string): KnownFeed | null {
  const q = query.toLowerCase();
  for (const feed of KNOWN_FEEDS) {
    if (feed.aliases.some((alias) => q.includes(alias))) {
      return feed;
    }
  }
  return null;
}

export type Episode = { title: string; url: string; published?: Date };

/** Newest episode from a podcast RSS feed.
 *
 * A small regex reader rather than an XML dependency: podcast RSS is a fixed shape, this runs in
 * the plugin sandbox, and the failure we care about (no enclosure) is reported rather than guessed
 * around. Feeds list newest-first per RSS convention; the pubDate is surfaced so callers can tell
 * the listener how old a bulletin is instead of passing off old news as current. */
export async function fetchNewestEpisode(feedUrl: string): Promise<Episode | null> {
  const response = await fetch(feedUrl, {
    headers: { "User-Agent": "openclaw-ha-control/1.0 (+moabot)" },
  });
  if (!response.ok) {
    throw new Error(`feed ${feedUrl} returned ${response.status}`);
  }
  const xml = await response.text();
  const firstItem = /<item[\s>][\s\S]*?<\/item>/i.exec(xml)?.[0];
  if (!firstItem) {
    return null;
  }
  const url = /<enclosure[^>]*\surl\s*=\s*["']([^"']+)["']/i.exec(firstItem)?.[1];
  if (!url) {
    return null;
  }
  const rawTitle =
    /<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/i.exec(firstItem)?.[1] ?? "";
  const rawDate = /<pubDate>\s*([\s\S]*?)\s*<\/pubDate>/i.exec(firstItem)?.[1];
  const published = rawDate ? new Date(rawDate) : undefined;
  return {
    title: rawTitle.trim().replace(/\s+/g, " "),
    url: url.trim(),
    published: published && !Number.isNaN(published.getTime()) ? published : undefined,
  };
}

/** Bulletins older than this are worth mentioning aloud. */
export const STALE_AFTER_HOURS = 4;

/** Human phrase for a bulletin's age, or null when it is recent enough to pass without comment. */
export function describeAge(published: Date | undefined, now: Date): string | null {
  if (!published) {
    return null;
  }
  const hours = (now.getTime() - published.getTime()) / 3_600_000;
  if (hours < STALE_AFTER_HOURS) {
    return null;
  }
  if (hours < 24) {
    const rounded = Math.round(hours);
    return `${rounded} hour${rounded === 1 ? "" : "s"} old`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} old`;
}
