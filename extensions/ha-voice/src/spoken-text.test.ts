import { describe, expect, it } from "vitest";
import { extractSpokenTextFromPayloads } from "./spoken-text.js";

describe("extractSpokenTextFromPayloads", () => {
  it("extracts the spoken field from a JSON-contract payload", () => {
    const text = extractSpokenTextFromPayloads([{ text: '{"spoken":"Bedroom lights are off."}' }]);
    expect(text).toBe("Bedroom lights are off.");
  });

  it("extracts JSON wrapped in a code fence", () => {
    const text = extractSpokenTextFromPayloads([{ text: '```json\n{"spoken":"Done."}\n```' }]);
    expect(text).toBe("Done.");
  });

  it("falls back to sanitized plain text when the model ignores the JSON contract", () => {
    const text = extractSpokenTextFromPayloads([{ text: "Sure, turning off the lights now." }]);
    expect(text).toBe("Sure, turning off the lights now.");
  });

  it("drops leading meta-reasoning paragraphs from plain text", () => {
    const text = extractSpokenTextFromPayloads([
      { text: "Reasoning: the user wants the lights off.\n\nTurning off the bedroom lights." },
    ]);
    expect(text).toBe("Turning off the bedroom lights.");
  });

  it("skips error and reasoning payloads", () => {
    const text = extractSpokenTextFromPayloads([
      { text: "some internal error", isError: true },
      { text: "internal reasoning", isReasoning: true },
      { text: '{"spoken":"All set."}' },
    ]);
    expect(text).toBe("All set.");
  });

  it("returns null when there is nothing speakable", () => {
    expect(extractSpokenTextFromPayloads([])).toBeNull();
    expect(extractSpokenTextFromPayloads([{ text: '{"spoken":""}' }])).toBeNull();
  });

  it("joins multiple speakable segments with a space", () => {
    const text = extractSpokenTextFromPayloads([
      { text: '{"spoken":"Turning off the lights."}' },
      { text: '{"spoken":"Done."}' },
    ]);
    expect(text).toBe("Turning off the lights. Done.");
  });
});
