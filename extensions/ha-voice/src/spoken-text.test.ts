import { describe, expect, it } from "vitest";
import { createIncrementalSpokenExtractor, extractSpokenTextFromPayloads } from "./spoken-text.js";

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

describe("createIncrementalSpokenExtractor", () => {
  it("yields the full value in one delta when fed as a single chunk", () => {
    const extractor = createIncrementalSpokenExtractor();
    const delta = extractor.push('{"spoken":"Bedroom lights are off.","continueConversation":false}');
    expect(delta).toBe("Bedroom lights are off.");
  });

  it("yields growing deltas as a JSON string streams in token-sized pieces", () => {
    const extractor = createIncrementalSpokenExtractor();
    const chunks = ['{"spo', 'ken":"', "Turning off the ", "bedroom lights", '.","continueConv', 'ersation":false}'];
    const deltas = chunks.map((c) => extractor.push(c));
    expect(deltas.join("")).toBe("Turning off the bedroom lights.");
    // Each individual push only returns what's newly decodable, not a repeat of prior text.
    expect(deltas.filter((d) => d.length > 0)).toEqual([
      "Turning off the ",
      "bedroom lights",
      ".",
    ]);
  });

  it("produces nothing before the spoken key has appeared in the buffer", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.push("{")).toBe("");
    expect(extractor.push('"con')).toBe("");
  });

  it("holds back a chunk that ends mid-escape-sequence until the next chunk completes it", () => {
    const extractor = createIncrementalSpokenExtractor();
    // The literal text is: Wait — really?  ("—" is an em dash, escaped as \\u2014 in JSON)
    const first = extractor.push('{"spoken":"Wait \\u201');
    const second = extractor.push('4really?"}');
    expect(first).toBe("Wait ");
    expect(second).toBe("—really?");
  });

  it("handles a chunk boundary landing exactly after a backslash", () => {
    const extractor = createIncrementalSpokenExtractor();
    const first = extractor.push('{"spoken":"Quote: \\');
    const second = extractor.push('"end quote\\""}');
    expect(first + second).toBe('Quote: "end quote"');
  });

  it("reports continueConversation:true even though it arrives after spoken has finished streaming", () => {
    // Regression: continueConversation arrives after spoken in the schema's key order, so a
    // naive implementation that only checks it when spoken just grew never reaches this check
    // in the (normal) case where spoken has already finished by the time it appears.
    const extractor = createIncrementalSpokenExtractor();
    extractor.push('{"spoken":"Which one?"');
    expect(extractor.continueConversation()).toBe(false);
    extractor.push(',"continueConversation":true}');
    expect(extractor.continueConversation()).toBe(true);
  });

  it("returns an empty delta on repeated pushes once fully decoded and unchanged", () => {
    const extractor = createIncrementalSpokenExtractor();
    extractor.push('{"spoken":"Done."}');
    expect(extractor.push("")).toBe("");
  });

  it("applies pronunciation fixups to streamed deltas, matching the batch extraction path", () => {
    // Regression: streamed deltas must not silently skip the same fixups
    // extractSpokenTextFromPayloads applies to the batch path.
    const extractor = createIncrementalSpokenExtractor();
    const delta = extractor.push('{"spoken":"Check the swale after rain."}');
    expect(delta).toBe("Check the swayl after rain.");
  });

  it("never corrupts already-emitted text when a fixup word straddles a chunk boundary", () => {
    // Regression: fixups must be applied per-delta (against a stable raw baseline), not to the
    // whole accumulated text re-diffed by length each time - the latter retroactively changes
    // characters at an index earlier than what was already emitted whenever the original and
    // replacement text diverge before the split point (here: "swal" | "e", "swale" -> "swayl"
    // diverges at index 3, inside the already-emitted "swal"), producing garbled output.
    const extractor = createIncrementalSpokenExtractor();
    const first = extractor.push('{"spoken":"Check the swal');
    const second = extractor.push('e after rain."}');
    // The accepted tradeoff: split exactly across the fixup word, so it's not corrected - but
    // the emitted text must still be exactly the real (unfixed) words, never a corrupted hybrid.
    expect(first + second).toBe("Check the swale after rain.");
  });

  it("holds back a complete high-surrogate escape until its low-surrogate partner arrives", () => {
    // An astral character (here: 😀, U+1F600) is encoded in JSON as a UTF-16 surrogate pair
    // 😀. A chunk boundary landing exactly between the two escapes must not decode
    // the lone high surrogate on its own.
    const extractor = createIncrementalSpokenExtractor();
    const first = extractor.push('{"spoken":"Great \\uD83D');
    const second = extractor.push('\\uDE00 done."}');
    expect(first).toBe("Great ");
    expect(second).toBe("😀 done.");
  });

  it("holds back the exposed high surrogate when the boundary lands inside the low surrogate", () => {
    // Regression: trimming the incomplete low-surrogate escape can expose a now-complete-looking
    // high surrogate underneath it, which must also be held back rather than decoded alone.
    const extractor = createIncrementalSpokenExtractor();
    const first = extractor.push('{"spoken":"Great \\uD83D\\uDE0');
    const second = extractor.push('0 done."}');
    expect(first).toBe("Great ");
    expect(second).toBe("😀 done.");
  });

  it("falls back to streaming raw plain text once enough buffer accumulates with no spoken key", () => {
    // Regression: SPOKEN_OUTPUT_RESPONSE_FORMAT's own comment documents this model breaking the
    // JSON contract on a real, measured fraction of turns (plain prose, no wrapper at all) -
    // without a fallback the whole turn would stream nothing.
    const extractor = createIncrementalSpokenExtractor();
    const first = extractor.push("Sure, turning off the bedroom ");
    const second = extractor.push("lights now.");
    expect(first + second).toBe("Sure, turning off the bedroom lights now.");
  });

  it("does not trigger the plain-text fallback while still short enough to plausibly be forming JSON", () => {
    const extractor = createIncrementalSpokenExtractor();
    // Under PLAIN_TEXT_FALLBACK_MIN_BUFFER's threshold - must wait, not guess.
    expect(extractor.push('{"spo')).toBe("");
  });

  it("does not trigger the plain-text fallback once the spoken key has actually appeared", () => {
    const extractor = createIncrementalSpokenExtractor();
    // Long buffer, but it does contain "spoken" - must stay in JSON mode and decode normally,
    // not misfire into plain-text mode just because the threshold was crossed already.
    const delta = extractor.push('{"spoken":"This sentence is long enough on its own."}');
    expect(delta).toBe("This sentence is long enough on its own.");
  });

  it("waits for the spoken key even when continueConversation streams first", () => {
    // Regression: nothing guarantees the schema's keys stream in declaration order, so a
    // long-enough buffer with no "spoken" yet must not be mistaken for broken plain text
    // while it's still visibly a forming JSON object.
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.push('{"continueConversation":false,')).toBe("");
    expect(extractor.push('"spoken":"Lights are on."}')).toBe("Lights are on.");
    expect(extractor.continueConversation()).toBe(false);
  });

  it("decodes a differently-cased spoken key, matching the batch path's case-insensitivity", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.push('{"Spoken":"Case should not matter."}')).toBe("Case should not matter.");
  });

  it("streams nothing when contract-breaking prose opens with meta-reasoning", () => {
    // The batch path strips these paragraphs before anything is spoken; a growing prefix can't
    // be paragraph-analyzed, and speech can't be retracted once played.
    const extractor = createIncrementalSpokenExtractor();
    const first = extractor.push("Reasoning: the user wants the ");
    const second = extractor.push("lights off.\n\nTurning them off now.");
    expect(first + second).toBe("");
  });

  it("streams nothing when contract-breaking prose contains a code fence", () => {
    const extractor = createIncrementalSpokenExtractor();
    expect(extractor.push("Here is the config you asked for: ```yaml\nfoo: bar\n```")).toBe("");
  });

  it("still streams ordinary contract-breaking prose", () => {
    // The common documented break is a plain conversational sentence - that must still stream,
    // otherwise the fallback buys nothing on the turns it exists for.
    const extractor = createIncrementalSpokenExtractor();
    const first = extractor.push("Sure, turning off the bedroom ");
    const second = extractor.push("lights now.");
    expect(first + second).toBe("Sure, turning off the bedroom lights now.");
  });
});
