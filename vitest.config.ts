import { defineConfig } from "vitest/config";

/**
 * WHY THIS FILE EXISTS: the default 5s timeout was silently grading the suite.
 *
 * Four test files shell out to other processes — eslint for the determinism
 * perimeter, git and node for the secret-file check, Postgres for the Tier B
 * flash sale. Each runs in about three seconds alone, and each drifts past five
 * under load. That was tolerable while the suite was small. It stopped being
 * tolerable for a reason specific to this project: **the mutation harness runs
 * the whole suite once per mutant, and it judges a mutant KILLED when the suite
 * exits non-zero.** A timeout exits non-zero. So every flaky timeout would have
 * been recorded as a kill, inflating the score in the direction that reads as
 * success — the same error as L7 (a mutant "killed" by an already-red suite)
 * and L19 (a mutant "killed" by a syntax error).
 *
 * Two defences, because either alone is thin: the budget here makes the
 * timeouts stop happening, and `scripts/mutate.mjs` retries a timed-out run and
 * then scores it INCONCLUSIVE rather than killed if it times out again.
 *
 * This is not a loosened assertion. Nothing in the suite asserts a wall-clock
 * number — SEMANTICS F4 forbids it — so a timeout here was never reporting a
 * correctness fact about the system, only about the machine.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
