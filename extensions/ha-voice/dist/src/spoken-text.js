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
const PRONUNCIATION_FIXUPS = [
    [/\bswales\b/gi, "swayls"],
    [/\bswale\b/gi, "swayl"],
];
function applyPronunciationFixups(text) {
    return PRONUNCIATION_FIXUPS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
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
                continueConversation = structured.continueConversation;
            }
            continue;
        }
        const plain = sanitizePlainSpokenText(rawText);
        if (plain) {
            spokenSegments.push(plain);
            continueConversation = guessContinueConversationFromPlainText(plain);
        }
    }
    const joined = spokenSegments.length > 0 ? spokenSegments.join(" ").trim() : null;
    return {
        text: joined ? applyPronunciationFixups(joined) : null,
        continueConversation,
    };
}
