import { describe, it, expect } from "vitest";
import { shrink, describeShrink } from "../src/oracle/shrink.js";
import { ControlPlane } from "../src/policy/controlPlane.js";
import { DEFAULT_CONTROL_PLANE } from "../src/policy/types.js";
import { referenceDecision, type RefEvent } from "../src/oracle/reference.js";
import { Rng } from "../src/core/rng.js";

/**
 * The shrinker, and its self-oracle.
 *
 * A shrinker is code, and a buggy one is worse than none: it hands you a
 * "minimal reproduction" that fails for a DIFFERENT reason than the original,
 * and you spend a day chasing the wrong root cause with total confidence. That
 * failure is silent, because a shrunk trace that still goes red looks like
 * success.
 *
 * So these tests are mostly about the ORACLE, not the reduction. Reducing a
 * trace is the easy half.
 */

describe("shrink — reduction", () => {
  it("reduces to the single element that causes the failure", () => {
    // Only the presence of 7 matters.
    const trace = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = shrink(trace, (c) => (c.includes(7) ? "I3" : null));

    expect(result.verified).toBe(true);
    expect(result.trace).toEqual([7]);
    expect(result.originalLength).toBe(10);
  });

  it("keeps BOTH elements when the failure needs a pair", () => {
    const trace = [1, 2, 3, 4, 5, 6, 7, 8];
    const result = shrink(trace, (c) => (c.includes(2) && c.includes(6) ? "I5" : null));

    expect(result.verified).toBe(true);
    expect([...result.trace].sort((a, b) => a - b)).toEqual([2, 6]);
  });

  it("reports 1-minimality with the number of removals actually checked", () => {
    const result = shrink([1, 2, 3, 4, 5], (c) => (c.includes(3) ? "I1" : null));
    const text = describeShrink(result);
    expect(text).toContain("1-minimal");
    expect(text).toContain("verified over");
    // Never claims global minimality, which ddmin does not provide.
    expect(text).not.toMatch(/\bminimal\b(?!.*verified)/);
  });

  it("refuses to shrink a trace that does not fail", () => {
    const result = shrink([1, 2, 3], () => null);
    expect(result.verified).toBe(false);
    expect(result.rejectedReason).toContain("does not fail");
    expect(result.trace).toEqual([1, 2, 3]);
  });
});

describe("shrink — S1: the shrunk trace must violate the SAME invariant", () => {
  it("rejects a shrink that lands on a DIFFERENT violation", () => {
    // A trace containing 1 fails I1; a trace containing 9 fails I9. Shrinking
    // must not "successfully" reduce an I1 failure into an I9 one — that is a
    // reproduction of a different bug, presented as the same one.
    const trace = [1, 5, 9];
    const fails = (c: readonly number[]): string | null => {
      if (c.includes(1)) return "I1";
      if (c.includes(9)) return "I9";
      return null;
    };

    const result = shrink(trace, fails);
    // Whatever it returns, the invariant must still be I1.
    expect(fails(result.trace)).toBe("I1");
  });

  it("returns the ORIGINAL when the invariant would change", () => {
    // Force the pathological case: the failure id flips once the trace is short.
    let calls = 0;
    const trace = [1, 2, 3, 4];
    const result = shrink(trace, (c) => {
      calls++;
      if (c.length === trace.length) return "I3";
      return c.length <= 2 ? "I7" : "I3";
    });

    expect(calls).toBeGreaterThan(0);
    if (!result.verified) {
      expect(result.rejectedReason).toMatch(/S1|S2/);
    }
    // The critical property: never hand back a trace whose failure differs.
    if (result.verified) {
      expect(result.trace.length).toBeGreaterThan(2);
    }
  });
});

describe("shrink — S2: 1-minimality is verified, not assumed", () => {
  it("checks every single-element removal", () => {
    const result = shrink([1, 2, 3, 4, 5], (c) =>
      c.includes(2) && c.includes(4) ? "I2" : null,
    );
    expect(result.verified).toBe(true);
    // Two elements survive, so exactly two removals were needed to prove it.
    expect(result.removalsChecked).toBe(result.trace.length);
  });

  it("reports NOT verified when a removable element survives", () => {
    // A predicate that ddmin cannot fully reduce in one pass: the failure needs
    // any two of the three, so no single chunk removal proves minimality
    // directly.
    const result = shrink([1, 2, 3], (c) => (c.length >= 2 ? "I4" : null));
    // Either it reduced to exactly 2 (1-minimal) or it flagged itself.
    if (result.verified) {
      expect(result.trace.length).toBe(2);
    } else {
      expect(result.rejectedReason).toContain("S2");
    }
  });
});

describe("shrink — S3: a flaky reproduction is not a reproduction", () => {
  /**
   * THIS TEST USED TO ASSERT NOTHING.
   *
   * It was `if (!result.verified) { expect(...) }` — and on this input the
   * shrink SUCCEEDS (`verified: true`, trace `[3]`, 7 calls, never reaching
   * the 40-call flake threshold), so the only assertion in the body was
   * skipped every single run. The one test guarding S3 was green whether or
   * not S3 existed. A conditional assertion is the quiet cousin of a checker
   * that never fires.
   */
  it("a predicate that never actually flakes in range shrinks normally", () => {
    let calls = 0;
    const result = shrink([1, 2, 3, 4, 5, 6], (c) => {
      calls++;
      if (calls > 40) return null;
      return c.includes(3) ? "I6" : null;
    });

    // Unconditional: this input does not reach the flake threshold, so the
    // shrink must succeed and reduce to the single element that matters.
    expect(result.verified, `rejected: ${result.rejectedReason ?? "-"}`).toBe(true);
    expect(result.trace).toEqual([3]);
    expect(calls, "the flake threshold was never reached").toBeLessThanOrEqual(40);
  });

  it("REJECTS a shrink whose failure is genuinely unstable", () => {
    // A predicate that flakes early enough that the shrinker must actually
    // notice. Without an input that trips it, S1/S2/S3 are dead code carrying
    // a paragraph of justification.
    let calls = 0;
    const result = shrink([1, 2, 3, 4, 5, 6, 7, 8], (c) => {
      calls++;
      if (calls > 6) return null; // flakes out mid-reduction
      return c.includes(4) ? "I6" : null;
    });

    expect(
      result.verified,
      "a reproduction that stops reproducing must never be handed back as verified",
    ).toBe(false);
    expect(result.rejectedReason, "and it must say which property failed").toMatch(
      /^S[123] failed/,
    );
  });
});

describe("shrink — causal dependencies", () => {
  it("never drops an event a survivor depends on", () => {
    // Model: event 20 is a "complete" that only makes sense if 10, its "admit",
    // is present. Dropping 10 while keeping 20 would produce a malformed trace
    // that fails for being nonsense rather than for the bug.
    const trace = [10, 15, 20, 25];
    const dependsOn = (kept: readonly number[], removed: number): boolean =>
      removed === 10 && kept.includes(20);

    const result = shrink(trace, (c) => (c.includes(20) ? "I8" : null), dependsOn);

    if (result.trace.includes(20)) {
      expect(
        result.trace.includes(10),
        "an event whose prerequisite was dropped is a malformed trace, not a smaller one",
      ).toBe(true);
    }
  });
});

/**
 * THE SHRINKER, POINTED AT THE ACTUAL SYSTEM.
 *
 * Every test above shrinks `number[]` against a synthetic predicate. That
 * exercises ddmin and the self-oracle, which is the hard half — but it means
 * the shrinker had never once been run on a `RefEvent[]` against the real
 * control plane and the real reference, so nothing showed that the piece the
 * README offers as a debugging tool works on the thing it is for.
 *
 * The failure shrunk here is a genuine differential divergence, produced the
 * same way the non-vacuity arm in `differential.test.ts` produces one: the
 * reference is handed a config whose caps are wrong, so the two engines really
 * do disagree on a real history.
 */
describe("shrink — against a real BALLAST trace", () => {
  const BROKEN_REFERENCE = {
    ...DEFAULT_CONTROL_PLANE,
    tenants: DEFAULT_CONTROL_PLANE.tenants.map((t) => ({ ...t, cap: 99 })),
  };

  /** Seeded history over the three real operations. */
  function makeHistory(seed: number, length: number): RefEvent[] {
    const rng = new Rng(seed);
    const tenants = DEFAULT_CONTROL_PLANE.tenants.map((t) => t.id);
    const events: RefEvent[] = [];
    const live: string[] = [];
    let vtime = 0;
    for (let i = 0; i < length; i++) {
      vtime += rng.nextInt(0, 4);
      const roll = rng.nextInt(0, 100);
      if (roll < 70 || live.length === 0) {
        const tenant = tenants[rng.nextInt(0, tenants.length)] as string;
        const runId = `r${i}`;
        events.push({ kind: "admit", vtime, tenant, runId });
        live.push(runId);
      } else {
        const idx = rng.nextInt(0, live.length);
        const runId = live[idx] as string;
        live.splice(idx, 1);
        events.push({ kind: "complete", vtime, runId });
      }
    }
    return events;
  }

  /** Returns the failing check's id, or null — the shape `shrink` needs. */
  function divergence(history: readonly RefEvent[]): string | null {
    const plane = new ControlPlane(DEFAULT_CONTROL_PLANE);
    const impl: boolean[] = [];
    for (const ev of history) {
      if (ev.kind === "admit") impl.push(plane.admit(ev.vtime, ev.tenant, ev.runId).ok);
      else {
        plane.complete(ev.vtime, ev.runId, "completed");
        impl.push(false);
      }
    }
    for (let i = 0; i < history.length; i++) {
      if (history[i]!.kind !== "admit") continue;
      const ref = referenceDecision(BROKEN_REFERENCE, history, i);
      if (impl[i] !== (ref.kind === "admitted")) return "DIFFERENTIAL";
    }
    return null;
  }

  /** A completion is meaningless without the admit that created its run. */
  function dependsOn(kept: readonly RefEvent[], removed: RefEvent): boolean {
    if (removed.kind !== "admit") return false;
    return kept.some((e) => e.kind !== "admit" && e.runId === removed.runId);
  }

  it("reduces a real differential divergence to a handful of events", () => {
    const seed = 1;
    const history = makeHistory(seed, 60);
    expect(divergence(history), "the premise: this seed must diverge").toBe(
      "DIFFERENTIAL",
    );

    const result = shrink(history, divergence, dependsOn);

    expect(result.verified, `rejected: ${result.rejectedReason ?? "-"}`).toBe(true);
    expect(result.originalLength).toBe(60);
    expect(
      result.trace.length,
      "a 60-event trace explains nothing; the point is the handful that matter",
    ).toBeLessThan(10);
    // S1 held by construction — same failure id — and S2 is what `verified`
    // means here: every remaining event was proven load-bearing.
    expect(divergence(result.trace)).toBe("DIFFERENTIAL");
    expect(result.removalsChecked).toBe(result.trace.length);
  });

  it("the shrunk trace is a legal history, not a smaller pile of events", () => {
    const result = shrink(makeHistory(1, 60), divergence, dependsOn);
    const admitted = new Set(
      result.trace.filter((e) => e.kind === "admit").map((e) => e.runId),
    );
    for (const ev of result.trace) {
      if (ev.kind === "admit") continue;
      expect(
        admitted.has(ev.runId),
        `${ev.kind} for ${ev.runId} with no admit — a malformed trace fails for ` +
          `being nonsense rather than for the bug`,
      ).toBe(true);
    }
  });
});

describe("shrink — the reduction is real, not cosmetic", () => {
  it("meaningfully shrinks a long trace", () => {
    const trace = Array.from({ length: 200 }, (_, i) => i);
    const result = shrink(trace, (c) => (c.includes(137) ? "I1" : null));
    expect(result.verified).toBe(true);
    expect(result.trace).toEqual([137]);
    expect(result.originalLength).toBe(200);
    // 200 -> 1 is the whole point: a 200-event trace tells you nothing.
    expect(result.trace.length).toBeLessThan(result.originalLength / 10);
  });
});
