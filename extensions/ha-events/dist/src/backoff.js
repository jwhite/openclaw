// Pure reconnect-backoff calculation, kept separate from the actual WS client so it's testable
// without a network. Exponential with a cap and jitter, so a flapping HA instance doesn't get
// hammered with reconnect attempts, and many restarted plugin instances don't reconnect in lockstep.
export function computeBackoffDelayMs(attempt, opts, random = Math.random) {
    const jitterRatio = opts.jitterRatio ?? 0.2;
    const exponential = opts.baseMs * 2 ** Math.max(0, attempt);
    const capped = Math.min(exponential, opts.maxMs);
    const jitter = capped * jitterRatio * (random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
}
