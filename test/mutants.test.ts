import { describe, it, expect } from "vitest";
import { ControlPlane } from "../src/policy/controlPlane.js";
import { ReplayLog, type SubscriberState } from "../src/policy/replayLog.js";
import { DEFAULT_CONTROL_PLANE } from "../src/policy/types.js";
import { checkAll, type CheckableState } from "../src/oracle/invariants.js";

/**
 * TIER 1 — semantic mutants.
 *
 * The criticism this answers is real and worth stating: *a hand-picked mutant
 * corpus is an answer key you wrote yourself.* Every mutant here is a bug I
 * thought of, so catching all of them proves the suite handles the bugs I
 * already imagined — which is weaker than it sounds.
 *
 * Two things make it worth doing anyway. First, each mutant is a specific,
 * named, plausible mistake tied to a SEMANTICS row, so a survivor tells you
 * exactly which guarantee is unguarded. Second, this tier is the *floor*, not
 * the ceiling: Tier 2 (mechanical AST mutation over src/policy) is what covers
 * the bugs I did not think of, and the mutation score there is the number worth
 * quoting.
 *
 * Each mutant is expressed as a small broken re-implementation of the specific
 * behaviour, then run against the SAME unchanged checker. If the checker stays
 * silent, the guarantee is not actually guarded.
 */

function baseState(): CheckableState {
  return {
    vtime: 0,
    inFlightByTenant: new Map(),
    capByTenant: new Map([["t", 2]]),
    poolCapacity: 4,
    totalClaimed: 0,
    claimsGranted: 0,
    releasesDone: 0,
    creditsSpent: new Map([["t", 0]]),
    creditsExpected: new Map([["t", 0]]),
    slotOwnerToken: new Map(),
    acceptedReleases: [],
    replayIds: [],
    effectCounts: new Map(),
    quiesced: false,
    ticksSinceQuiesce: 0,
    livenessBoundN: 50,
  };
}

/** A mutant is caught iff the checker reports at least one violation. */
function caught(state: CheckableState): boolean {
  return checkAll(state).length > 0;
}

describe("Tier 1 — semantic mutants (each MUST be caught)", () => {
  it("M1: cap checked before the claim instead of inside it (SEMANTICS B2)", () => {
    // Two admits both observed inFlight = cap-1 and both proceeded.
    const s: CheckableState = {
      ...baseState(),
      inFlightByTenant: new Map([["t", 3]]),
      totalClaimed: 3,
      claimsGranted: 3,
    };
    expect(caught(s), "over-cap must be caught by I1").toBe(true);
  });

  it("M2: release runs twice on an error path (SEMANTICS D4, I5)", () => {
    const s: CheckableState = {
      ...baseState(),
      acceptedReleases: [
        { slotId: "slot-0", tokenUsed: 1, tokenCurrent: 1, priorReleasesOfGeneration: 1 },
      ],
    };
    expect(caught(s), "double release must be caught by I5").toBe(true);
  });

  it("M3: fencing-token check skipped on release (SEMANTICS C1)", () => {
    const s: CheckableState = {
      ...baseState(),
      acceptedReleases: [
        { slotId: "slot-0", tokenUsed: 2, tokenCurrent: 9, priorReleasesOfGeneration: 0 },
      ],
    };
    expect(caught(s), "stale-token release must be caught by I5").toBe(true);
  });

  it("M4: conservation counter incremented outside the atomic region (I3)", () => {
    const s: CheckableState = {
      ...baseState(),
      claimsGranted: 5,
      releasesDone: 2,
      totalClaimed: 2,
    };
    expect(caught(s), "claims - releases != totalClaimed must be caught by I3").toBe(
      true,
    );
  });

  it("M5: credit debited twice for one duplicate delivery (SEMANTICS A7, I4)", () => {
    const s: CheckableState = {
      ...baseState(),
      creditsSpent: new Map([["t", 2]]),
      creditsExpected: new Map([["t", 1]]),
    };
    expect(caught(s), "credit drift must be caught by I4").toBe(true);
  });

  it("M6: non-idempotent completion handler — the CAS dropped (I8)", () => {
    const s: CheckableState = { ...baseState(), effectCounts: new Map([["msg-1", 2]]) };
    expect(caught(s), "double effect must be caught by I8").toBe(true);
  });

  it("M7: pool overcommitted while every tenant is under cap (I2)", () => {
    const s: CheckableState = {
      ...baseState(),
      inFlightByTenant: new Map([
        ["a", 2],
        ["b", 2],
        ["c", 2],
      ]),
      capByTenant: new Map([
        ["a", 2],
        ["b", 2],
        ["c", 2],
      ]),
      poolCapacity: 4,
      totalClaimed: 6,
      claimsGranted: 6,
    };
    const ids = checkAll(s).map((v) => v.invariant);
    expect(ids, "I2 must catch what I1 structurally cannot").toContain("I2");
    expect(ids).not.toContain("I1");
  });

  it("M8: replay id reused after retention eviction (SEMANTICS E3, I7)", () => {
    const s: CheckableState = { ...baseState(), replayIds: [1, 2, 3, 2] };
    expect(caught(s), "id reuse must be caught by I7").toBe(true);
  });

  it("M9: capacity orphaned — release skipped on the pod-death path (I6)", () => {
    const s: CheckableState = {
      ...baseState(),
      totalClaimed: 2,
      claimsGranted: 4,
      releasesDone: 2,
      quiesced: true,
      ticksSinceQuiesce: 200,
      livenessBoundN: 50,
      inFlightByTenant: new Map([["t", 2]]),
    };
    expect(caught(s), "orphaned capacity must be caught by I6").toBe(true);
  });

  it("M10: a tenant admitted with no configured cap at all (I1)", () => {
    const s: CheckableState = {
      ...baseState(),
      inFlightByTenant: new Map([["stranger", 1]]),
      totalClaimed: 1,
      claimsGranted: 1,
    };
    expect(caught(s), "unknown tenant must be caught by I1").toBe(true);
  });
});

describe("Tier 1 — behavioural mutants against the real components", () => {
  /**
   * These run the ACTUAL implementation and assert it does NOT behave like the
   * mutant. Distinct from the state-level mutants above: those prove the checker
   * can see a broken state, these prove the code does not produce one.
   */

  it("M11: completion is idempotent — the effect never applies twice", () => {
    const plane = new ControlPlane(DEFAULT_CONTROL_PLANE);
    plane.admit(0, "acme", "r1");
    for (let i = 0; i < 20; i++) plane.complete(1 + i, "r1", "completed");
    expect(plane.effectCountsMap().get("r1")).toBe(1);
  });

  it("M12: credit is NOT spent by a rejected admit", () => {
    const plane = new ControlPlane(DEFAULT_CONTROL_PLANE);
    // acme cap is 3; fire 12 admits and confirm only 3 credits moved.
    for (let i = 0; i < 12; i++) plane.admit(0, "acme", `r${i}`);
    expect(plane.creditsSpentMap().get("acme")).toBe(3);
  });

  it("M13: a stale release is refused, not accepted", () => {
    const plane = new ControlPlane(DEFAULT_CONTROL_PLANE);
    const a = plane.admit(0, "acme", "r1");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const past = DEFAULT_CONTROL_PLANE.leaseTicks + 1;
    plane.admit(past, "globex", "r2"); // reclaims and reissues the slot
    const stale = plane.release(past, a.slotId, a.token);
    expect(stale.ok).toBe(false);
    // And crucially: nothing was recorded as an ACCEPTED release with a bad token.
    const bad = plane.counters.acceptedReleases.filter(
      (r) => r.tokenUsed !== r.tokenCurrent,
    );
    expect(bad).toEqual([]);
  });

  it("M14: subscriber credit decrements on ACK, not on send (SEMANTICS E6)", () => {
    // The mutant: decrement on send. Under it, a subscriber that never acks
    // keeps receiving, so backpressure never engages.
    const log = new ReplayLog(1000, 10_000);
    for (let i = 0; i < 20; i++) {
      log.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" });
    }
    const sub: SubscriberState = { name: "dead", cursor: 1, credits: 3, inFlight: 0 };

    const first = log.deliver(sub);
    expect(first.length).toBe(3);
    // The subscriber never acks. Every later delivery must send NOTHING.
    for (let i = 0; i < 5; i++) {
      expect(
        log.deliver(sub),
        "an unresponsive subscriber must stop receiving — that is backpressure",
      ).toEqual([]);
    }
  });

  it("M15: a paused subscriber loses nothing — entries wait, they are not dropped", () => {
    const log = new ReplayLog(1000, 10_000);
    for (let i = 0; i < 10; i++) {
      log.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" });
    }
    const sub: SubscriberState = { name: "s", cursor: 1, credits: 0, inFlight: 0 };
    expect(log.deliver(sub)).toEqual([]);
    sub.credits = 10;
    const resumed = log.deliver(sub);
    expect(resumed.length, "everything buffered while paused is still there").toBe(10);
    expect(resumed[0]!.replayId, "resumes exactly where it paused").toBe(1);
  });

  it("M16: a cursor below retention errors rather than silently fast-forwarding", () => {
    const log = new ReplayLog(3, 10_000);
    for (let i = 0; i < 20; i++) {
      log.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" });
    }
    log.evict(20);
    const r = log.readFrom(1, 10);
    expect(r.ok).toBe(false);
  });
});

describe("the corpus is not vacuous", () => {
  it("a healthy state produces NO violations — so a caught mutant means something", () => {
    // Without this, every mutant test above could pass simply because the
    // checker screams at everything.
    expect(checkAll(baseState())).toEqual([]);
  });
});
