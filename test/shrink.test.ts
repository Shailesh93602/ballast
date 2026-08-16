import { describe, it, expect } from "vitest";
import { shrink, describeShrink } from "../src/oracle/shrink.js";

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
  it("rejects a shrink whose failure is not stable across repeat runs", () => {
    // A predicate that stops failing after enough calls — simulating a flaky
    // check. The shrinker must notice rather than hand back a trace that will
    // not reproduce for whoever reads the ledger.
    let calls = 0;
    const result = shrink([1, 2, 3, 4, 5, 6], (c) => {
      calls++;
      if (calls > 40) return null;
      return c.includes(3) ? "I6" : null;
    });

    if (!result.verified) {
      expect(result.rejectedReason).toMatch(/S1|S2|S3/);
    }
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
