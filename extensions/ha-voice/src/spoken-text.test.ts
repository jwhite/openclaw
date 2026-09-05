import { describe, expect, it } from "vitest";
import { createIncrementalSpokenExtractor, extractSpokenTextFromPayloads } from "./spoken-text.js";

describe("extractSpokenTextFromPayloads", () => {
  it("extracts the spoken field from a JSON-contract payload", () => {
    const result = extractSpokenTextFromPayloads([
      { text: '{"spoken":"Bedroom lights are off."}' },
    ]);
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

describe("createIncrementalSpokenExtractor", () => {
  /** The assistant stream hands out cumulative snapshots, so tests feed growing prefixes. */
  const snapshots = (
    extractor: ReturnType<typeof createIncrementalSpokenExtractor>,
    steps: string[],
  ) => steps.map((s) => extractor.pushSnapshot(s));

  it("yields the full value in one delta when the whole snapshot arrives at once", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(
      extractor.pushSnapshot('{"spoken":"Bedroom lights are off.","continueConversation":false}'),
    ).toBe("Bedroom lights are off.");
  });

  it("preserves word boundaries across snapshots — the defect that made TTS speak invented words", () => {
    // Regression: the previous design appended onBlockReply chunks, which are a lossy partition
    // (the chunker drops the whitespace at each break), yielding "The quick"+"brown fox" =
    // "quickbrown". Concatenated deltas must reproduce the text exactly, spaces included.
    const extractor = createIncrementalSpokenExtractor();
    const deltas = snapshots(extractor, [
      '{"spoken":"The quick',
      '{"spoken":"The quick brown fox jumps over',
      '{"spoken":"The quick brown fox jumps over the lazy dog."}',
    ]);
    expect(deltas.join("")).toBe("The quick brown fox jumps over the lazy dog.");
  });

  it("emits only the newly-decodable part of each snapshot", () => {
    const extractor = createIncrementalSpokenExtractor();
    const deltas = snapshots(extractor, [
      '{"spoken":"Turning off ',
      '{"spoken":"Turning off the bedroom lights."}',
    ]);
    expect(deltas).toEqual(["Turning off ", "the bedroom lights."]);
  });

  it("produces nothing before the spoken key has appeared", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.pushSnapshot("{")).toBe("");
    expect(extractor.pushSnapshot('{"con')).toBe("");
  });

  it("holds back an incomplete unicode escape until the next snapshot completes it", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.pushSnapshot('{"spoken":"Wait \\u201')).toBe("Wait ");
    expect(extractor.pushSnapshot('{"spoken":"Wait \\u2014really?"}')).toBe("\u2014really?");
  });

  it("holds back a lone high surrogate until its partner arrives", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.pushSnapshot('{"spoken":"Great \\uD83D')).toBe("Great ");
    expect(extractor.pushSnapshot('{"spoken":"Great \\uD83D\\uDE00 done."}')).toBe(
      "\u{1F600} done.",
    );
  });

  it("holds back the exposed high surrogate when the boundary lands inside the low surrogate", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.pushSnapshot('{"spoken":"Great \\uD83D\\uDE0')).toBe("Great ");
    expect(extractor.pushSnapshot('{"spoken":"Great \\uD83D\\uDE00 done."}')).toBe(
      "\u{1F600} done.",
    );
  });

  it("reports continueConversation even though it arrives after spoken has finished", () => {
    const extractor = createIncrementalSpokenExtractor();
    extractor.pushSnapshot('{"spoken":"Which one?"');
    expect(extractor.continueConversation()).toBe(false);
    extractor.pushSnapshot('{"spoken":"Which one?","continueConversation":true}');
    expect(extractor.continueConversation()).toBe(true);
  });

  it("returns nothing for an unchanged snapshot", () => {
    const extractor = createIncrementalSpokenExtractor();
    extractor.pushSnapshot('{"spoken":"Done."}');
    expect(extractor.pushSnapshot('{"spoken":"Done."}')).toBe("");
  });

  it("resyncs quietly when the model replaces its answer mid-flight", () => {
    // Already-spoken audio cannot be recalled, so a divergent snapshot must not re-emit text
    // the listener has heard - it just resyncs.
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.pushSnapshot('{"spoken":"Five minutes."}')).toBe("Five minutes.");
    expect(extractor.pushSnapshot('{"spoken":"Ten minutes."}')).toBe("");
  });

  it("applies pronunciation fixups to streamed deltas", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.pushSnapshot('{"spoken":"Check the swale after rain."}')).toBe(
      "Check the swayl after rain.",
    );
  });

  it("still respells a word whose snapshot boundary falls inside it", () => {
    // Found live 2026-08-16: every PRONUNCIATION_FIXUPS rule is \b-anchored, so applying it to a
    // delta that holds only "swal" matched nothing and the satellite said "swale" while the
    // returned text said "swayl". The partial word is held back until it is whole.
    const extractor = createIncrementalSpokenExtractor();
    const deltas = [
      '{"spoken":"Check the swal',
      '{"spoken":"Check the swale afte',
      '{"spoken":"Check the swale after rain."}',
    ].map((s) => extractor.pushSnapshot(s));
    expect(deltas.join("")).toBe("Check the swayl after rain.");
  });

  it("never emits a partial word mid-stream", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.pushSnapshot('{"spoken":"Turning off the bedr')).toBe("Turning off the ");
    expect(extractor.pushSnapshot('{"spoken":"Turning off the bedroom ')).toBe("bedroom ");
  });

  it("flush releases the held final word when the JSON never closes", () => {
    // The plain-text fallback has no closing quote to signal completion, so without flush() the
    // last word of the answer would be held back forever and never spoken.
    const extractor = createIncrementalSpokenExtractor();
    const streamed = extractor.pushSnapshot("Sure, turning off the lights now");
    expect(streamed).toBe("Sure, turning off the lights ");
    expect(extractor.flush()).toBe("now");
  });

  it("flush is empty once a closed JSON value already released everything", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.pushSnapshot('{"spoken":"All done."}')).toBe("All done.");
    expect(extractor.flush()).toBe("");
  });

  it("waits for the spoken key even when continueConversation streams first", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.pushSnapshot('{"continueConversation":false,')).toBe("");
    expect(extractor.pushSnapshot('{"continueConversation":false,"spoken":"Lights are on."}')).toBe(
      "Lights are on.",
    );
  });

  it("decodes a differently-cased spoken key, matching the batch path", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.pushSnapshot('{"Spoken":"Case should not matter."}')).toBe(
      "Case should not matter.",
    );
  });

  it("streams ordinary prose when the model breaks the JSON contract entirely", () => {
    const extractor = createIncrementalSpokenExtractor();
    const deltas = snapshots(extractor, [
      "Sure, turning off the bedroom ",
      "Sure, turning off the bedroom lights now.",
    ]);
    expect(deltas.join("")).toBe("Sure, turning off the bedroom lights now.");
  });

  it("does not fall back to prose while the snapshot still looks like forming JSON", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.pushSnapshot('{"spo')).toBe("");
  });

  it("streams nothing when contract-breaking prose opens with meta-reasoning", () => {
    const extractor = createIncrementalSpokenExtractor();
    const deltas = snapshots(extractor, [
      "Reasoning: the user wants the ",
      "Reasoning: the user wants the lights off.\n\nTurning them off now.",
    ]);
    expect(deltas.join("")).toBe("");
  });

  it("streams nothing when contract-breaking prose contains a code fence", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.pushSnapshot("Here is the config you asked for: ```yaml\nfoo: bar\n```")).toBe(
      "",
    );
  });
});
