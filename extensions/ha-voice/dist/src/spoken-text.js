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
};
function normalizeSpokenText(value) {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : null;
}
function tryParseSpokenJson(text) {
    const candidates = [];
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
            const parsed = JSON.parse(candidate);
            if (typeof parsed?.spoken !== "string") {
                continue;
            }
            return {
                spoken: normalizeSpokenText(parsed.spoken) ?? "",
                continueConversation: parsed.continueConversation === true,
            };
        }
        catch {
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
        const decoded = JSON.parse(`"${inlineSpokenMatch[1] ?? ""}"`);
        const inlineContinueMatch = trimmed.match(/"continueConversation"\s*:\s*(true|false)/i);
        return {
            spoken: normalizeSpokenText(decoded) ?? "",
            continueConversation: (inlineContinueMatch?.[1] ?? "").toLowerCase() === "true",
        };
    }
    catch {
        return null;
    }
}
function isLikelyMetaReasoningParagraph(paragraph) {
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
    if (lower.startsWith("the user ") &&
        (lower.includes("i should") || lower.includes("i need to") || lower.includes("i will"))) {
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
function guessContinueConversationFromPlainText(text) {
    return text.trim().endsWith("?");
}
function sanitizePlainSpokenText(text) {
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
const PRONUNCIATION_FIXUPS = [
    // Confirmed live 2026-08-06: Kokoro read "swale" with a short-A sound (rhyming "shallow"/
    // "pal") instead of the correct long-A (rhyming "whale"/"pale"). "ay" is an unambiguous
    // long-A spelling English G2P models reliably get right.
    [/\bswales\b/gi, "swayls"],
    [/\bswale\b/gi, "swayl"],
];
function applyPronunciationFixups(text) {
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
function tryExtractPartialSpoken(buffer) {
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
        return JSON.parse(`"${raw}"`);
    }
    catch {
        return null;
    }
}
/**
 * Stateful, incremental counterpart to extractSpokenTextFromPayloads (S5.1).
 *
 * Takes cumulative snapshots rather than appended chunks, and that is load-bearing rather than
 * incidental: the obvious source, onBlockReply, hands out a *lossy* partition — the block chunker
 * drops the whitespace at every break point (right for chat messages, where each chunk is its own
 * message) so rejoining its chunks yields "The quick"+"brown fox" = "quickbrown", which TTS then
 * pronounces as an invented word. Diffing successive snapshots of the assistant stream's own
 * cumulative text cannot lose a separator that way.
 *
 * Falls back to streaming raw prose when the model breaks the JSON contract outright, and
 * suppresses even that if the prose opens with meta-reasoning or a code fence, neither of which
 * is safe to speak and neither of which can be recalled once played.
 */
// Below this many characters with no "spoken" key seen yet, stay in JSON-waiting mode rather than
// risk a false-positive plain-text fallback on a snapshot that is still forming.
const PLAIN_TEXT_FALLBACK_MIN_BUFFER = 20;
// A trailing run of word characters may still be growing ("swal" -> "swale"), and every
// PRONUNCIATION_FIXUPS rule is \b-anchored, so normalizing it now would either miss the rule or
// emit letters that the completed word rewrites. Held back until the next snapshot completes the
// word, or until flush().
const TRAILING_PARTIAL_WORD = /[\p{L}\p{N}'’-]+$/u;
/** The same closing-quote-terminated shape tryParseSpokenJson uses: once it matches, "spoken" has
 * finished streaming and its last word can be released without waiting for flush(). */
const SPOKEN_VALUE_CLOSED_PATTERN = /"spoken"\s*:\s*"(?:[^"\\]|\\.)*"/i;
/** Matches normalizeSpokenText's batch-path collapsing, then applies the \b-anchored TTS
 * respellings. Applied to the whole cumulative text rather than to a delta: a word-level rule that
 * only ever sees half a word silently does nothing, which is how streamed audio said "swale" while
 * the returned text said "swayl". */
function normalizeForSpeech(text) {
    return applyPronunciationFixups(text.replace(/\s+/g, " "));
}
export function createIncrementalSpokenExtractor() {
    let emitted = "";
    let pendingDecoded = "";
    let continueConversationValue = false;
    let plainTextMode = false;
    let plainTextSuppressed = false;
    /**
     * Normalizes the cumulative text and returns only what extends what has already been spoken.
     *
     * The three cases are deliberately distinct. Already covered (a repeat snapshot, or one whose
     * held-back trailing word makes it shorter than what was spoken) must leave `emitted` alone:
     * rewinding it would let a later flush re-speak, or newly speak, text that was already settled.
     * A true divergence means the model replaced its own answer mid-flight; audio already spoken
     * cannot be recalled, so adopt the new text silently rather than repeat what was heard.
     */
    const emitThrough = (stableDecoded) => {
        const normalized = normalizeForSpeech(stableDecoded);
        if (emitted.startsWith(normalized)) {
            return "";
        }
        if (!normalized.startsWith(emitted)) {
            emitted = normalized;
            return "";
        }
        const delta = normalized.slice(emitted.length);
        emitted = normalized;
        return delta;
    };
    return {
        pushSnapshot(fullRawText) {
            if (!plainTextMode) {
                // continueConversation follows spoken in the schema, so by the time it appears spoken has
                // normally already finished growing - checked on every snapshot, not gated on new text.
                const ccMatch = fullRawText.match(CONTINUE_CONVERSATION_PATTERN);
                if (ccMatch) {
                    continueConversationValue = ccMatch[1].toLowerCase() === "true";
                }
            }
            let decoded = plainTextMode ? fullRawText : tryExtractPartialSpoken(fullRawText);
            if (decoded === null) {
                // Any JSON-object opening means a contract response is still forming (nothing guarantees
                // "spoken" streams before "continueConversation") - only genuinely non-JSON output falls
                // through to the plain-prose path the batch side also tolerates.
                if (fullRawText.length < PLAIN_TEXT_FALLBACK_MIN_BUFFER ||
                    fullRawText.trimStart().startsWith("{")) {
                    return "";
                }
                plainTextMode = true;
                decoded = fullRawText;
            }
            if (plainTextMode) {
                if (emitted.length === 0 && !plainTextSuppressed) {
                    plainTextSuppressed = isLikelyMetaReasoningParagraph(decoded) || decoded.includes("```");
                }
                if (plainTextSuppressed) {
                    return "";
                }
            }
            pendingDecoded = decoded;
            // Once the JSON string has closed, nothing more can extend the last word, so release it
            // immediately instead of making the caller's flush() supply the final word of every answer.
            const spokenValueClosed = !plainTextMode && SPOKEN_VALUE_CLOSED_PATTERN.test(fullRawText);
            if (spokenValueClosed) {
                return emitThrough(decoded);
            }
            return emitThrough(decoded.replace(TRAILING_PARTIAL_WORD, ""));
        },
        flush() {
            return emitThrough(pendingDecoded);
        },
        continueConversation() {
            return continueConversationValue;
        },
    };
}
export function extractSpokenTextFromPayloads(payloads) {
    const spokenSegments = [];
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
