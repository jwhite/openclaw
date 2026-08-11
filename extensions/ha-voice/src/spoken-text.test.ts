import { describe, expect, it } from "vitest";
import { extractSpokenTextFromPayloads } from "./spoken-text.js";

describe("extractSpokenTextFromPayloads", () => {
  it("extracts the spoken field from a JSON-contract payload", () => {
    const result = extractSpokenTextFromPayloads([{ text: '{"spoken":"Bedroom lights are off."}' }]);
    expect(result.text).toBe("Bedroom lights are off.");
    expect(result.continueConversation).toBe(false);
  });

  it("extracts JSON wrapped in a code fence", () => {
    const result = extractSpokenTextFromPayloads([{ text: '```json\n{"spoken":"Done."}\n```' }]);
    expect(result.text).toBe("Done.");
  });

  it("falls back to sanitized plain text when the model ignores the JSON contract", () => {
    const result = extractSpokenTextFromPayloads([{ text: "Sure, turning off the lights now." }]);
    expect(result.text).toBe("Sure, turning off the lights now.");
    expect(result.continueConversation).toBe(false);
  });

  it("drops leading meta-reasoning paragraphs from plain text", () => {
    const result = extractSpokenTextFromPayloads([
      { text: "Reasoning: the user wants the lights off.\n\nTurning off the bedroom lights." },
    ]);
    expect(result.text).toBe("Turning off the bedroom lights.");
  });

  it("skips error and reasoning payloads", () => {
    const result = extractSpokenTextFromPayloads([
      { text: "some internal error", isError: true },
      { text: "internal reasoning", isReasoning: true },
      { text: '{"spoken":"All set."}' },
    ]);
    expect(result.text).toBe("All set.");
  });

  it("returns null text when there is nothing speakable", () => {
    expect(extractSpokenTextFromPayloads([]).text).toBeNull();
    expect(extractSpokenTextFromPayloads([{ text: '{"spoken":""}' }]).text).toBeNull();
  });

  it("joins multiple speakable segments with a space", () => {
    const result = extractSpokenTextFromPayloads([
      { text: '{"spoken":"Turning off the lights."}' },
      { text: '{"spoken":"Done."}' },
    ]);
    expect(result.text).toBe("Turning off the lights. Done.");
  });

  it("carries continueConversation:true through from a JSON-contract payload", () => {
    const result = extractSpokenTextFromPayloads([
      { text: '{"spoken":"Which playlist did you mean?","continueConversation":true}' },
    ]);
    expect(result.text).toBe("Which playlist did you mean?");
    expect(result.continueConversation).toBe(true);
  });

  it("defaults continueConversation to false when the key is omitted", () => {
    const result = extractSpokenTextFromPayloads([{ text: '{"spoken":"Done."}' }]);
    expect(result.continueConversation).toBe(false);
  });

  it("reflects the last spoken segment's continueConversation value across multiple payloads", () => {
    const result = extractSpokenTextFromPayloads([
      { text: '{"spoken":"Started the timer.","continueConversation":true}' },
      { text: '{"spoken":"Anything else?","continueConversation":true}' },
    ]);
    expect(result.continueConversation).toBe(true);

    const followedByPlain = extractSpokenTextFromPayloads([
      { text: '{"spoken":"Started the timer.","continueConversation":true}' },
      { text: "All done." },
    ]);
    expect(followedByPlain.continueConversation).toBe(false);
  });

  it("parses continueConversation from the inline-regex fallback path", () => {
    // Trailing content after the JSON object breaks JSON.parse on every brace-extraction
    // candidate, forcing the inline-regex fallback further down tryParseSpokenJson.
    const result = extractSpokenTextFromPayloads([
      {
        text: '{"spoken":"Which one?","continueConversation":true} then a stray } elsewhere',
      },
    ]);
    expect(result.text).toBe("Which one?");
    expect(result.continueConversation).toBe(true);
  });

  it("guesses continueConversation:true for plain-text fallback ending in a question mark", () => {
    // Verified live 2026-08-06: real contract breaks were genuine questions ("For how many
    // minutes? Or should I set a default — like 30 or 60 minutes?") that incorrectly closed the
    // mic under a hard-false default.
    const result = extractSpokenTextFromPayloads([
      { text: "For how many minutes? Or should I set a default, like 30 or 60 minutes?" },
    ]);
    expect(result.continueConversation).toBe(true);
  });

  it("does not guess continueConversation:true for plain-text fallback that isn't a question", () => {
    const result = extractSpokenTextFromPayloads([{ text: "Sure, turning off the lights now." }]);
    expect(result.continueConversation).toBe(false);
  });

  it("respells swale/swales for Kokoro, whole-word and case-insensitive", () => {
    expect(
      extractSpokenTextFromPayloads([{ text: '{"spoken":"Check the swale after rain."}' }]).text,
    ).toBe("Check the swayl after rain.");
    expect(
      extractSpokenTextFromPayloads([{ text: '{"spoken":"Two Swales need clearing."}' }]).text,
    ).toBe("Two swayls need clearing.");
    // Whole-word only — must not touch unrelated words that happen to contain the substring.
    expect(
      extractSpokenTextFromPayloads([{ text: '{"spoken":"That is unswaleable, ignore it."}' }])
        .text,
    ).toBe("That is unswaleable, ignore it.");
  });
});
