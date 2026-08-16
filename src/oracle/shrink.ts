/**
 * Trace shrinking, with a self-oracle.
 *
 * A 2,000-event failing trace tells you almost nothing. A 4-event one tells you
 * the bug. So when a seed fails, the trace is minimised before anyone looks at
 * it.
 *
 * THE PART THAT USUALLY GETS SKIPPED: a shrinker is itself code, and a buggy one
 * is worse than none — it hands you a "minimal reproduction" that fails for a
 * DIFFERENT reason than the original, and you spend a day chasing the wrong root
 * cause with total confidence. That failure is silent, because a shrunk trace
 * that still goes red looks like success.
 *
 * So every shrink is verified against three properties before it is returned:
 *
 *   S1  the shrunk trace violates the SAME invariant — same id, not merely
 *       "something still fails"
 *   S2  the result is 1-MINIMAL: removing any single remaining element makes it
 *       pass. Reported as "1-minimal (verified over k removals)", never as the
 *       bare word "minimal", which would claim global minimality that ddmin does
 *       not provide
 *   S3  the shrunk trace replays to an identical outcome across runs — a shrunk
 *       trace that is itself flaky is not a reproduction
 *
 * If any property fails, the shrink is REJECTED and the original returned. A
 * shrinker that cannot prove its own output is one that should not be trusted
 * with it.
 */

export interface ShrinkResult<T> {
  readonly trace: readonly T[];
  readonly originalLength: number;
  /** True only if S1–S3 all held. */
  readonly verified: boolean;
  /** How many single-element removals were checked to establish 1-minimality. */
  readonly removalsChecked: number;
  readonly rejectedReason?: string;
}

/**
 * Delta-debugging shrink.
 *
 * @param trace       the failing sequence
 * @param fails       runs the trace and returns the failing invariant id, or
 *                    null if it passes. Returning the ID (not a boolean) is what
 *                    makes S1 checkable.
 * @param dependsOn   optional causal guard: `dependsOn(a, b)` is true when `b`
 *                    cannot be dropped while `a` survives. Prevents producing a
 *                    trace that fails only because it is malformed.
 */
export function shrink<T>(
  trace: readonly T[],
  fails: (candidate: readonly T[]) => string | null,
  dependsOn?: (kept: readonly T[], candidate: T) => boolean,
): ShrinkResult<T> {
  const originalLength = trace.length;
  const originalFailure = fails(trace);

  if (originalFailure === null) {
    return {
      trace,
      originalLength,
      verified: false,
      removalsChecked: 0,
      rejectedReason: "the input trace does not fail — nothing to shrink",
    };
  }

  let current = [...trace];

  // ddmin: try ever-finer partitions, removing whole chunks while the SAME
  // invariant still fires.
  let granularity = 2;
  while (current.length >= 2) {
    const chunkSize = Math.ceil(current.length / granularity);
    let reduced = false;

    for (let start = 0; start < current.length; start += chunkSize) {
      const candidate = [...current.slice(0, start), ...current.slice(start + chunkSize)];
      if (candidate.length === 0) continue;
      if (dependsOn !== undefined) {
        const broken = current
          .slice(start, start + chunkSize)
          .some((removed) => dependsOn(candidate, removed));
        if (broken) continue;
      }
      // Same invariant, not merely "still fails" — dropping a chunk can easily
      // produce a DIFFERENT violation, and following that would shrink toward
      // the wrong bug.
      if (fails(candidate) === originalFailure) {
        current = candidate;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }

    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(granularity * 2, current.length);
    }
  }

  // ─── The self-oracle ──────────────────────────────────────────────────────

  // S1 — same invariant.
  const shrunkFailure = fails(current);
  if (shrunkFailure !== originalFailure) {
    return {
      trace,
      originalLength,
      verified: false,
      removalsChecked: 0,
      rejectedReason:
        `S1 failed: original violated ${originalFailure}, shrunk violates ` +
        `${shrunkFailure ?? "nothing"}. Returning the original — a reproduction ` +
        `that fails for a different reason sends you after the wrong bug.`,
    };
  }

  // S2 — 1-minimality. Removing any single element must make it pass.
  let removalsChecked = 0;
  for (let i = 0; i < current.length; i++) {
    const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
    removalsChecked++;
    if (fails(candidate) === originalFailure) {
      return {
        trace: current,
        originalLength,
        verified: false,
        removalsChecked,
        rejectedReason:
          `S2 failed: element ${i} can still be removed, so this is not 1-minimal. ` +
          `Returned anyway (it is a valid reproduction, just not minimal).`,
      };
    }
  }

  // S3 — stability. The same trace must fail the same way on a repeat run.
  if (fails(current) !== originalFailure) {
    return {
      trace,
      originalLength,
      verified: false,
      removalsChecked,
      rejectedReason:
        "S3 failed: the shrunk trace is not stable across runs. A flaky " +
        "reproduction is not a reproduction.",
    };
  }

  return { trace: current, originalLength, verified: true, removalsChecked };
}

/** Human-readable summary. Never says "minimal" unqualified — see S2. */
export function describeShrink<T>(result: ShrinkResult<T>): string {
  if (!result.verified) {
    return (
      `shrink NOT verified (${result.originalLength} → ${result.trace.length}): ` +
      `${result.rejectedReason ?? "unknown"}`
    );
  }
  return (
    `${result.originalLength} → ${result.trace.length} events, ` +
    `1-minimal (verified over ${result.removalsChecked} removals)`
  );
}
