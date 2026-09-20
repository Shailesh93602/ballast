import { describe, it, expect } from "vitest";
import { ControlPlane } from "../src/policy/controlPlane.js";
import { DEFAULT_CONTROL_PLANE } from "../src/policy/types.js";
import { referenceDecision, type RefEvent } from "../src/oracle/reference.js";
import { Rng } from "../src/core/rng.js";
import { checkAll, type CheckableState } from "../src/oracle/invariants.js";

/**
 * The model-based differential.
 *
 * Same event history through two independent engines; the decision sequences
 * must match element for element. The implementation is fast because it keeps
 * incremental state; the reference is quadratic because it keeps none. They
 * share no machinery, which is the only reason their agreement is evidence.
 *
 * WHAT THIS CANNOT CATCH, stated up front: both halves were written by the same
 * author from the same SEMANTICS.md. This validates implementation-against-intent
 * and is structurally blind to intent-against-reality. If a spec row is wrong,
 * both agree and this passes. That blindness is why I1–I8 exist independently.
 */

/** Generate a random-but-seeded workload. */
function makeHistory(seed: number, length: number): RefEvent[] {
  const rng = new Rng(seed);
  const tenants = DEFAULT_CONTROL_PLANE.tenants.map((t) => t.id);
  const events: RefEvent[] = [];
  const live: string[] = [];
  let vtime = 0;
  let nextRun = 0;

  for (let i = 0; i < length; i++) {
    vtime += rng.nextInt(0, 4);
    const roll = rng.nextInt(0, 100);
    if (roll < 55 || live.length === 0) {
      const tenant = tenants[rng.nextInt(0, tenants.length)] as string;
      const runId = `r${nextRun++}`;
      events.push({ kind: "admit", vtime, tenant, runId });
      live.push(runId);
    } else if (roll < 75) {
      const idx = rng.nextInt(0, live.length);
      const runId = live[idx] as string;
      events.push({ kind: "complete", vtime, runId });
      live.splice(idx, 1);
    } else if (roll < 90) {
      const idx = rng.nextInt(0, live.length);
      const runId = live[idx] as string;
      events.push({ kind: "release", vtime, runId });
      live.splice(idx, 1);
    } else {
      const idx = rng.nextInt(0, live.length);
      const runId = live[idx] as string;
      events.push({ kind: "cancel", vtime, runId });
      live.splice(idx, 1);
    }
  }
  return events;
}

/** Run a history through the real control plane, recording its decisions. */
function runImplementation(history: readonly RefEvent[]): string[] {
  const plane = new ControlPlane(DEFAULT_CONTROL_PLANE);
  const slotOf = new Map<string, { slotId: string; token: number }>();
  const decisions: string[] = [];

  for (const ev of history) {
    switch (ev.kind) {
      case "admit": {
        const r = plane.admit(ev.vtime, ev.tenant, ev.runId);
        if (r.ok) {
          slotOf.set(ev.runId, { slotId: r.slotId, token: r.token });
          decisions.push(`admitted:${ev.runId}`);
        } else {
          decisions.push(`rejected:${ev.runId}:${r.reason}`);
        }
        break;
      }
      case "release": {
        const held = slotOf.get(ev.runId);
        if (held === undefined) {
          decisions.push(`noop:${ev.runId}`);
          break;
        }
        const r = plane.release(ev.vtime, held.slotId, held.token);
        decisions.push(r.ok ? `released:${ev.runId}` : `noop:${ev.runId}`);
        break;
      }
      case "complete": {
        const r = plane.complete(ev.vtime, ev.runId, "completed");
        if (r.ok) decisions.push(`completed:${ev.runId}:${r.duplicate}`);
        else decisions.push(`noop:${ev.runId}`);
        break;
      }
      case "cancel": {
        const r = plane.cancel(ev.vtime, ev.runId);
        decisions.push(r === "cancelled" ? `cancelled:${ev.runId}` : `noop:${ev.runId}`);
        break;
      }
    }
  }
  return decisions;
}

/**
 * The length every generated history runs to.
 *
 * It is a named constant because the corpus has to REACH the regimes it claims
 * to cover, and two of them sat just outside the old length of 40:
 *
 *   - a tumbling-window boundary at `windowTicks` = 100. The longest of the
 *     2,000 histories reached tick 85, so **zero** of them ever rolled a
 *     window — the exact outcome SEMANTICS A2 names as the thing to avoid
 *     ("too large and the corpus never observes a window boundary, leaving
 *     A1's burst behaviour untested").
 *   - a lease expiring (40 ticks) and the slot being RE-CLAIMED by another
 *     tenant, which is the only state in which a stale claimant exists at all.
 *
 * `corpusReach` below asserts both are actually hit, so shortening this back
 * to make CI faster fails loudly instead of silently emptying the corpus.
 */
const HISTORY_LENGTH = 120;

function stateOf(plane: ControlPlane, vtime: number): CheckableState {
  const c = plane.counters;
  return {
    vtime,
    inFlightByTenant: plane.inFlightByTenant(),
    capByTenant: plane.capsMap(),
    poolCapacity: DEFAULT_CONTROL_PLANE.poolCapacity,
    totalClaimed: plane.totalClaimed,
    claimsGranted: c.claimsGranted,
    releasesDone: c.releasesDone,
    creditsSpent: plane.creditsSpentMap(),
    // NOT `creditsSpentMap()` again. It used to be, on both sides — so I4
    // compared a map to ITSELF for every event of every seed and was
    // structurally incapable of firing. `creditsExpected()` is the independent
    // recomputation the CheckableState field has always advertised.
    creditsExpected: plane.creditsExpected(),
    slotOwnerToken: new Map(),
    acceptedReleases: c.acceptedReleases,
    replayIds: plane.log.assignedIds(),
    effectCounts: plane.effectCountsMap(),
    quiesced: false,
    ticksSinceQuiesce: 0,
    livenessBoundN: 100,
  };
}

/**
 * A corpus is worth what it REACHES, not what it runs.
 *
 * Both numbers below were zero-or-near-zero at the old history length while
 * every test stayed green, which is the same failure as a fault injector that
 * injects nothing (KG2): the suite reports coverage of a regime it never
 * entered.
 */
describe("the corpus reaches the regimes it claims to cover", () => {
  it("crosses a tumbling-window boundary on a meaningful share of seeds", () => {
    let crossed = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const history = makeHistory(seed, HISTORY_LENGTH);
      const last = history[history.length - 1];
      if (last !== undefined && last.vtime >= DEFAULT_CONTROL_PLANE.windowTicks) {
        crossed++;
      }
    }
    expect(
      crossed,
      `only ${crossed}/2000 histories reach tick ${DEFAULT_CONTROL_PLANE.windowTicks}; ` +
        `SEMANTICS A1's tumbling-window behaviour is untested below that`,
    ).toBeGreaterThan(1000);
  });

  it("produces a stale claimant — an expired lease whose slot is re-claimed", () => {
    // The precondition for the whole fencing-token argument. If no history ever
    // reaches it, I5 and SEMANTICS C1/C4 are being asserted against a state the
    // corpus cannot construct.
    let seedsWithReassignment = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const history = makeHistory(seed, HISTORY_LENGTH);
      const plane = new ControlPlane(DEFAULT_CONTROL_PLANE);
      const tokenOf = new Map<string, { slotId: string; token: number }>();
      let sawReassignment = false;
      for (const ev of history) {
        if (ev.kind !== "admit") continue;
        const r = plane.admit(ev.vtime, ev.tenant, ev.runId);
        if (!r.ok) continue;
        for (const [, held] of tokenOf) {
          if (held.slotId === r.slotId && held.token !== r.token) sawReassignment = true;
        }
        tokenOf.set(ev.runId, { slotId: r.slotId, token: r.token });
      }
      if (sawReassignment) seedsWithReassignment++;
    }
    expect(
      seedsWithReassignment,
      "no history ever hands a slot to a second claimant, so nothing in the " +
        "corpus can exercise a stale token",
    ).toBeGreaterThan(100);
  });
});

describe("invariants hold across a randomized corpus", () => {
  it("no invariant is violated over 2,000 seeded histories", () => {
    const failures: Array<{ seed: number; detail: string }> = [];
    for (let seed = 1; seed <= 2000; seed++) {
      const history = makeHistory(seed, HISTORY_LENGTH);
      const plane = new ControlPlane(DEFAULT_CONTROL_PLANE);
      const slotOf = new Map<string, { slotId: string; token: number }>();

      for (const ev of history) {
        if (ev.kind === "admit") {
          const r = plane.admit(ev.vtime, ev.tenant, ev.runId);
          if (r.ok) slotOf.set(ev.runId, { slotId: r.slotId, token: r.token });
        } else if (ev.kind === "release") {
          const held = slotOf.get(ev.runId);
          if (held !== undefined) plane.release(ev.vtime, held.slotId, held.token);
        } else if (ev.kind === "complete") {
          plane.complete(ev.vtime, ev.runId, "completed");
        } else {
          plane.cancel(ev.vtime, ev.runId);
        }

        // AFTER EVERY EVENT — SEMANTICS F1. An end-of-run check would miss
        // transient violations, which is exactly what faults produce.
        const violations = checkAll(stateOf(plane, ev.vtime));
        if (violations.length > 0) {
          failures.push({ seed, detail: violations[0]!.detail });
          break;
        }
      }
    }
    expect(failures.slice(0, 5), "invariant violations found").toEqual([]);
  });
});

describe("differential: implementation vs reference", () => {
  it("agrees on the admit/reject decision sequence across 300 histories", () => {
    const divergences: Array<{ seed: number; index: number; impl: string; ref: string }> =
      [];

    for (let seed = 1; seed <= 300; seed++) {
      const history = makeHistory(seed, HISTORY_LENGTH);
      const impl = runImplementation(history);

      for (let i = 0; i < history.length; i++) {
        const refDecision = referenceDecision(DEFAULT_CONTROL_PLANE, history, i);
        const implDecision = impl[i] as string;

        // Compare only the ADMIT decisions: those are the ones both engines
        // compute independently from the same predicate. Release/complete
        // bookkeeping differs in representation between the two, and forcing
        // agreement on representation rather than on decision would be
        // comparing implementations, not behaviour.
        if (history[i]!.kind !== "admit") continue;

        const implAdmitted = implDecision.startsWith("admitted:");
        const refAdmitted = refDecision.kind === "admitted";
        // The REASON is compared too, not just the admitted/rejected bit.
        // SEMANTICS B5 makes the reasons distinguishable on purpose — "you are
        // over your limit" and "the system is full" are opposite operator
        // actions — so a differential that stops at the bit leaves the whole
        // RejectReason union, which both engines derive independently, unchecked.
        const refRendered = refAdmitted
          ? `admitted:${history[i]!.runId}`
          : `rejected:${history[i]!.runId}:${"reason" in refDecision ? refDecision.reason : "?"}`;
        if (implAdmitted !== refAdmitted || implDecision !== refRendered) {
          divergences.push({
            seed,
            index: i,
            impl: implDecision,
            ref: `${refDecision.kind}${"reason" in refDecision ? ":" + refDecision.reason : ""}`,
          });
          break;
        }
      }
    }

    expect(
      divergences.slice(0, 5),
      "first divergences between implementation and reference",
    ).toEqual([]);
  });

  it("the differential is not vacuous — it detects a deliberately wrong reference", () => {
    // If the comparison could not fail, its agreement would mean nothing. Feed
    // the reference a config with a different cap and confirm they diverge.
    const brokenConfig = {
      ...DEFAULT_CONTROL_PLANE,
      tenants: DEFAULT_CONTROL_PLANE.tenants.map((t) => ({ ...t, cap: 99 })),
    };
    let sawDivergence = false;

    for (let seed = 1; seed <= 50 && !sawDivergence; seed++) {
      const history = makeHistory(seed, 30);
      const impl = runImplementation(history);
      for (let i = 0; i < history.length; i++) {
        if (history[i]!.kind !== "admit") continue;
        const ref = referenceDecision(brokenConfig, history, i);
        const implAdmitted = (impl[i] as string).startsWith("admitted:");
        if (implAdmitted !== (ref.kind === "admitted")) {
          sawDivergence = true;
          break;
        }
      }
    }
    expect(sawDivergence, "a wrong reference must diverge from the implementation").toBe(
      true,
    );
  });
});
