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
