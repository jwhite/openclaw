import { describe, expect, it } from "vitest";
import { computeBackoffDelayMs } from "./backoff.js";

describe("computeBackoffDelayMs", () => {
  const noJitter = () => 0.5; // random() = 0.5 -> jitter term is exactly 0

  it("doubles the delay each attempt, capped at maxMs", () => {
    const opts = { baseMs: 1000, maxMs: 60_000, jitterRatio: 0 };
    expect(computeBackoffDelayMs(0, opts, noJitter)).toBe(1000);
    expect(computeBackoffDelayMs(1, opts, noJitter)).toBe(2000);
    expect(computeBackoffDelayMs(2, opts, noJitter)).toBe(4000);
    expect(computeBackoffDelayMs(10, opts, noJitter)).toBe(60_000);
  });

  it("never returns a negative delay even with strong negative jitter", () => {
    const opts = { baseMs: 1000, maxMs: 60_000, jitterRatio: 1 };
    const alwaysMin = () => 0; // random()*2-1 = -1 -> maximal negative jitter
    const delay = computeBackoffDelayMs(0, opts, alwaysMin);
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it("clamps negative attempt numbers to attempt 0 behavior", () => {
    const opts = { baseMs: 1000, maxMs: 60_000, jitterRatio: 0 };
    expect(computeBackoffDelayMs(-5, opts, noJitter)).toBe(1000);
  });

  it("defaults jitterRatio to 0.2 when omitted", () => {
    const opts = { baseMs: 1000, maxMs: 60_000 };
    const delay = computeBackoffDelayMs(0, opts, noJitter);
    // jitterRatio 0.2, random()=0.5 -> jitter term 0 regardless, so delay stays exactly base
    expect(delay).toBe(1000);
  });
});
