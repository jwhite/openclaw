// Extracts clean, speakable text from agent reply payloads.
//
// Mirrors the "spoken JSON contract" pattern used by the voice-call plugin: forcing the model to
// answer as `{"spoken":"..."}` keeps markdown, tool commentary, and meta-reasoning out of what
// gets sent to Piper — a smart-speaker response has the exact same "must be safe to read aloud"
// constraint as a phone call.
import { normalizeLowercaseStringOrEmpty } from "../runtime-api.js";

export const SPOKEN_OUTPUT_CONTRACT = [
  "Output format requirements:",
  '- Return only valid JSON in this exact shape: {"spoken":"...","continueConversation":false}',
  "- Do not include markdown, code fences, planning text, or extra keys.",
  '- Put exactly what should be spoken aloud into "spoken".',
  '- If there is nothing to say, return {"spoken":""}.',
  '- "continueConversation" is required. Set it to true when your reply expects the user to',
  "  respond before the exchange is really done - a clarifying question, confirming a multi-step",
  '  action you just took, or an open invitation like "anything else?". Set it to false for a',
  "  complete, standalone answer that doesn't need a reply.",
].join("\n");

/**
 * Enforces SPOKEN_OUTPUT_CONTRACT's shape at the provider level (OpenAI-Responses-API structured
 * outputs) instead of relying on prompt instruction alone. Verified live 2026-08-06: the model
 * was NOT reliably emitting the JSON contract on plain instruction (raw payloads came back as
 * plain prose, e.g. "Do you like pineapple on pizza?" with no JSON wrapper at all) — this closes
 * that gap at the API layer rather than just wording the prompt more forcefully.
 */
export const SPOKEN_OUTPUT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "ha_voice_spoken_response",
    strict: true,
    schema: {
      type: "object",
      properties: {
        spoken: { type: "string" },
        continueConversation: { type: "boolean" },
      },
      required: ["spoken", "continueConversation"],
      additionalProperties: false,
    },
  },
} as const;

export type SpokenPayload = {
  text?: string;
  isError?: boolean;
  isReasoning?: boolean;
};

export type ExtractedSpokenResult = {
  text: string | null;
  continueConversation: boolean;
};

type ParsedSpokenPayload = {
  spoken: string;
  continueConversation: boolean;
};

function normalizeSpokenText(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function tryParseSpokenJson(text: string): ParsedSpokenPayload | null {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  candidates.push(trimmed);

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1]);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { spoken?: unknown; continueConversation?: unknown };
      if (typeof parsed?.spoken !== "string") {
        continue;
      }
      return {
        spoken: normalizeSpokenText(parsed.spoken) ?? "",
        continueConversation: parsed.continueConversation === true,
      };
    } catch {
      // Continue trying other candidates.
    }
  }

  // Same "spoken":"..." shape as SPOKEN_VALUE_PATTERN below (shared by the incremental decode
  // path), plus a required closing quote - a complete payload, unlike a streaming chunk, always
  // has one. Keep both in sync if the contract's escaping/quoting rules ever change.
  const inlineSpokenMatch = trimmed.match(/"spoken"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  if (!inlineSpokenMatch) {
    return null;
  }

  try {
    const decoded = JSON.parse(`"${inlineSpokenMatch[1] ?? ""}"`) as string;
    const inlineContinueMatch = trimmed.match(/"continueConversation"\s*:\s*(true|false)/i);
    return {
      spoken: normalizeSpokenText(decoded) ?? "",
      continueConversation: (inlineContinueMatch?.[1] ?? "").toLowerCase() === "true",
    };
  } catch {
    return null;
  }
}

function isLikelyMetaReasoningParagraph(paragraph: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(paragraph);
  if (!lower) {
    return false;
  }
  if (lower.startsWith("thinking process")) {
    return true;
  }
  if (lower.startsWith("reasoning:") || lower.startsWith("analysis:")) {
    return true;
  }
  if (
    lower.startsWith("the user ") &&
    (lower.includes("i should") || lower.includes("i need to") || lower.includes("i will"))
  ) {
    return true;
  }
  return false;
}

/**
 * Fallback signal for when the model breaks SPOKEN_OUTPUT_CONTRACT entirely (plain prose, no JSON
 * wrapper) despite SPOKEN_OUTPUT_RESPONSE_FORMAT's schema enforcement. Verified live 2026-08-06:
 * enforcement is real but not 100% reliable on this provider/model — two of four turns in one
 * real satellite exchange broke contract, and both were genuine questions ending in "?" that
 * incorrectly closed the mic under the old hard-`false` fallback. Not the primary signal (the
 * model's own JSON field is, when present) — only engaged once structured parsing has already
 * failed, so a stray trailing "?" on a rhetorical pleasantry is a much better failure mode than
 * guaranteed-wrong on every contract break.
 */
function guessContinueConversationFromPlainText(text: string): boolean {
  return text.trim().endsWith("?");
}

function sanitizePlainSpokenText(text: string): string | null {
  const withoutCodeFences = text.replace(/```[\s\S]*?```/g, " ").trim();
  if (!withoutCodeFences) {
    return null;
  }
  const paragraphs = withoutCodeFences
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  while (paragraphs.length > 1 && isLikelyMetaReasoningParagraph(paragraphs[0])) {
    paragraphs.shift();
  }
  return normalizeSpokenText(paragraphs.join(" "));
}

/**
 * TTS pronunciation fixups. Kokoro (via `nordwestt/kokoro-wyoming` on mangosteen — confirmed by
 * reading its server source directly) exposes no lexicon/pronunciation-override API; it passes
 * plain text straight into kokoro-onnx's G2P. Respelling is the only available lever for words
 * its G2P gets wrong. Case-insensitive, whole-word only, applied to the final spoken text right
 * before it's returned.
 */
const PRONUNCIATION_FIXUPS: ReadonlyArray<readonly [RegExp, string]> = [
  // Confirmed live 2026-08-06: Kokoro read "swale" with a short-A sound (rhyming "shallow"/
  // "pal") instead of the correct long-A (rhyming "whale"/"pale"). "ay" is an unambiguous
  // long-A spelling English G2P models reliably get right.
  [/\bswales\b/gi, "swayls"],
  [/\bswale\b/gi, "swayl"],
];

function applyPronunciationFixups(text: string): string {
  return PRONUNCIATION_FIXUPS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

/** Shared with tryParseSpokenJson's inline fallback (which additionally requires a closing
 * quote) so the two decode paths can't silently drift on the "spoken" field's raw value. Case-
 * insensitive to match that inline fallback's own /i flag. */
const SPOKEN_VALUE_PATTERN = /"spoken"\s*:\s*"((?:[^"\\]|\\.)*)/i;
const CONTINUE_CONVERSATION_PATTERN = /"continueConversation"\s*:\s*(true|false)/i;

/**
 * Extracts as much of "spoken"'s value as is currently decodable from a growing, possibly-
 * incomplete JSON buffer (streamed token-by-token). Loops trimming trailing incomplete/lone-
 * surrogate `\uXXXX` escapes (a non-ASCII char split across a chunk boundary) since trimming one
 * can expose another underneath it - e.g. an emoji's low surrogate cut mid-escape leaves a
 * complete-looking high surrogate that must also be held back. Uses JSON.parse for the actual
 * decode rather than hand-rolling escapes.
 */
// Matches a trailing incomplete \uXXXX (0-3 hex digits) or a trailing *complete* high-surrogate
// escape (\uD800-\uDBFF, still waiting for its low-surrogate partner) - both cases trim back by
// the same "\u" (2 chars) plus however many hex digits were captured.
const TRAILING_INCOMPLETE_UNICODE_ESCAPE = /\\u([0-9a-fA-F]{0,3}|[dD][89abAB][0-9a-fA-F]{2})$/;

function tryExtractPartialSpoken(buffer: string): string | null {
  const match = buffer.match(SPOKEN_VALUE_PATTERN);
  if (!match) {
    return null;
  }
  let raw = match[1] ?? "";
  for (;;) {
    const incompleteEscape = raw.match(TRAILING_INCOMPLETE_UNICODE_ESCAPE);
    if (!incompleteEscape) {
      break;
    }
    raw = raw.slice(0, raw.length - 2 - incompleteEscape[1].length);
  }
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return null;
  }
}

export type IncrementalSpokenExtractor = {
  /** Feed the next raw text chunk (in stream order); returns the newly-available speakable
   * delta (pronunciation fixups applied), or "" when nothing new is decodable yet. */
  push(rawTextChunk: string): string;
  /** Best-known continueConversation value; only meaningful once the JSON object has closed. */
  continueConversation(): boolean;
};

/**
 * Stateful, incremental counterpart to extractSpokenTextFromPayloads - handles "spoken" arriving
 * in pieces across onBlockReply chunks (S5.1). Deltas diff against the raw decoded text (always
 * a growing prefix); fixups apply per-delta rather than to the re-diffed whole, since a fixup
 * word straddling a chunk boundary can otherwise retroactively rewrite already-emitted output
 * (see the "never corrupts already-emitted text" test). Falls back to streaming raw plain-text
 * chunks once enough buffer has accumulated with no "spoken" key in sight, matching the batch
 * path's own tolerance for a broken JSON contract. Callers must discard an instance and start a
 * fresh one at a tool_start/pre_compaction boundary - see response-generator.ts.
 */
// Below this many buffered characters with no "spoken" key found yet, stay in JSON-waiting mode
// rather than risk a false-positive plain-text fallback on a very short, still-forming chunk.
const PLAIN_TEXT_FALLBACK_MIN_BUFFER = 20;

export function createIncrementalSpokenExtractor(): IncrementalSpokenExtractor {
  let buffer = "";
  let emittedLength = 0;
  let continueConversationValue = false;
  let plainTextMode = false;
  let plainTextSuppressed = false;

  return {
    push(rawTextChunk: string): string {
      buffer += rawTextChunk;

      if (!plainTextMode) {
        // continueConversation follows spoken in the schema, so by the time it appears spoken
        // has normally already finished growing - checked unconditionally (not gated on new
        // spoken text), but only while still in JSON mode; plain text provably has no such key.
        const ccMatch = buffer.match(CONTINUE_CONVERSATION_PATTERN);
        if (ccMatch) {
          continueConversationValue = ccMatch[1].toLowerCase() === "true";
        }

        const decodedSoFar = tryExtractPartialSpoken(buffer);
        if (decodedSoFar !== null) {
          if (decodedSoFar.length <= emittedLength) {
            return "";
          }
          const rawDelta = decodedSoFar.slice(emittedLength);
          emittedLength = decodedSoFar.length;
          return applyPronunciationFixups(rawDelta.replace(/\s+/g, " "));
        }
        // No "spoken" key has appeared despite enough buffered text - this model/provider
        // breaks SPOKEN_OUTPUT_RESPONSE_FORMAT's contract on a real, measured fraction of turns
        // (see SPOKEN_OUTPUT_RESPONSE_FORMAT's own comment), so without this the whole turn would
        // stream nothing. Falls back to streaming the raw buffer directly, same tolerance the
        // batch path (sanitizePlainSpokenText) already has for contract-breaking plain prose.
        // Any JSON-object opening means a contract response is still forming (the "spoken" key
        // may simply not have streamed yet, and nothing guarantees it streams before
        // "continueConversation") - only genuinely non-JSON output falls through to plain text.
        if (buffer.length < PLAIN_TEXT_FALLBACK_MIN_BUFFER || buffer.trimStart().startsWith("{")) {
          return "";
        }
        plainTextMode = true;
      }

      // The batch path runs contract-breaking prose through sanitizePlainSpokenText before it is
      // ever spoken; a growing prefix cannot be paragraph-analyzed that way, so rather than risk
      // speaking meta-reasoning or a code fence aloud, suppress streaming for the rest of this
      // turn and let the caller's terminal payload carry the sanitized batch text. Re-checked
      // until the first emission, since "The user wants..." only reveals itself as reasoning
      // once more of the sentence has arrived - after that, audio can't be un-spoken.
      if (emittedLength === 0 && !plainTextSuppressed) {
        plainTextSuppressed = isLikelyMetaReasoningParagraph(buffer) || buffer.includes("```");
      }
      if (plainTextSuppressed) {
        return "";
      }

      if (buffer.length <= emittedLength) {
        return "";
      }
      const rawDelta = buffer.slice(emittedLength);
      emittedLength = buffer.length;
      // Collapses internal whitespace runs like normalizeSpokenText's batch-path counterpart,
      // matching the final canonical text - trim is deliberately not applied here (see the
      // class docstring above): trimming a growing prefix can eat a boundary space that turns
      // out to be internal once more text arrives.
      return applyPronunciationFixups(rawDelta.replace(/\s+/g, " "));
    },
    continueConversation() {
      return continueConversationValue;
    },
  };
}

export function extractSpokenTextFromPayloads(payloads: SpokenPayload[]): ExtractedSpokenResult {
  const spokenSegments: string[] = [];
  let continueConversation = false;
  for (const payload of payloads) {
    if (payload.isError || payload.isReasoning) {
      continue;
    }
    const rawText = payload.text?.trim() ?? "";
    if (!rawText) {
      continue;
    }
    const structured = tryParseSpokenJson(rawText);
    if (structured !== null) {
      if (structured.spoken.length > 0) {
        spokenSegments.push(structured.spoken);
        // Reflects the most recent spoken segment — what the user would actually be replying to.
        continueConversation = structured.continueConversation;
      }
      continue;
    }
    const plain = sanitizePlainSpokenText(rawText);
    if (plain) {
      spokenSegments.push(plain);
      // No reliable JSON signal here — fall back to a text heuristic rather than hard-`false`
      // (see guessContinueConversationFromPlainText's own comment for why).
      continueConversation = guessContinueConversationFromPlainText(plain);
    }
  }
  const joined = spokenSegments.length > 0 ? spokenSegments.join(" ").trim() : null;
  return {
    text: joined ? applyPronunciationFixups(joined) : null,
    continueConversation,
  };
}
