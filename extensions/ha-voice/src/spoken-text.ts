// Extracts clean, speakable text from agent reply payloads.
//
// Mirrors the "spoken JSON contract" pattern used by the voice-call plugin: forcing the model to
// answer as `{"spoken":"..."}` keeps markdown, tool commentary, and meta-reasoning out of what
// gets sent to Piper — a smart-speaker response has the exact same "must be safe to read aloud"
// constraint as a phone call.
import { normalizeLowercaseStringOrEmpty } from "../runtime-api.js";

export const SPOKEN_OUTPUT_CONTRACT = [
  "Output format requirements:",
  '- Return only valid JSON in this exact shape: {"spoken":"..."}',
  "- Do not include markdown, code fences, planning text, or extra keys.",
  '- Put exactly what should be spoken aloud into "spoken".',
  '- If there is nothing to say, return {"spoken":""}.',
].join("\n");

export type SpokenPayload = {
  text?: string;
  isError?: boolean;
  isReasoning?: boolean;
};

function normalizeSpokenText(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function tryParseSpokenJson(text: string): string | null {
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
      const parsed = JSON.parse(candidate) as { spoken?: unknown };
      if (typeof parsed?.spoken !== "string") {
        continue;
      }
      return normalizeSpokenText(parsed.spoken) ?? "";
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
    return normalizeSpokenText(decoded) ?? "";
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

export function extractSpokenTextFromPayloads(payloads: SpokenPayload[]): string | null {
  const spokenSegments: string[] = [];
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
      if (structured.length > 0) {
        spokenSegments.push(structured);
      }
      continue;
    }
    const plain = sanitizePlainSpokenText(rawText);
    if (plain) {
      spokenSegments.push(plain);
    }
  }
  return spokenSegments.length > 0 ? spokenSegments.join(" ").trim() : null;
}
