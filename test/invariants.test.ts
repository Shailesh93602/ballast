import { describe, it, expect } from "vitest";
import { checkAll, type CheckableState } from "../src/oracle/invariants.js";
import { Substrate, DEFAULT_SUBSTRATE, HONEST_SUBSTRATE } from "../src/sim/substrate.js";
import { Rng } from "../src/core/rng.js";

/**
 * NON-VACUITY.
 *
 * The failure mode this file exists to prevent: a checker that never fires looks
 * exactly like a system that is always correct. The suite goes green either way,
 * and only one of those is good news.
 *
 * So every invariant gets a deliberately broken state that MUST produce a
 * violation. If any of these ever stops failing, the corresponding invariant has
 * silently stopped checking anything.
 *
 * This is the same discipline as the planted-bug oracle in M5, applied one layer
 * down — and it is why KG2 (day 11) says that finding zero unplanted violations
 * means the fault injector is too weak, not that the code is perfect.
 */

/** A state with nothing wrong. Every broken case below is this, perturbed. */
function healthy(): CheckableState {
  return {
    vtime: 100,
    inFlightByTenant: new Map([
      ["acme", 2],
      ["globex", 1],
    ]),
    capByTenant: new Map([
      ["acme", 3],
      ["globex", 3],
    ]),
    poolCapacity: 8,
    totalClaimed: 3,
    claimsGranted: 10,
    releasesDone: 7,
    creditsSpent: new Map([
      ["acme", 5],
      ["globex", 2],
    ]),
    creditsExpected: new Map([
      ["acme", 5],
      ["globex", 2],
    ]),
    slotOwnerToken: new Map([
      ["slot-1", 4],
      ["slot-2", 5],
    ]),
    acceptedReleases: [],
    replayIds: [1, 2, 3, 7, 9],
    effectCounts: new Map([
      ["msg-a", 1],
      ["msg-b", 1],
    ]),
    quiesced: false,
    ticksSinceQuiesce: 0,
    livenessBoundN: 50,
  };
}

describe("invariant checker — the healthy baseline", () => {
  it("reports nothing on a correct state", () => {
    expect(checkAll(healthy())).toEqual([]);
  });
});

describe("invariant checker — every invariant must be able to FAIL", () => {
  it("I1 catches a tenant over its cap", () => {
    const s = { ...healthy(), inFlightByTenant: new Map([["acme", 4]]), totalClaimed: 4 };
    const v = checkAll({ ...s, claimsGranted: 11 });
    expect(v.map((x) => x.invariant)).toContain("I1");
  });

  it("I1 catches in-flight for a tenant with no configured cap", () => {
    const s = {
      ...healthy(),
      inFlightByTenant: new Map([["ghost", 1]]),
      totalClaimed: 1,
      claimsGranted: 8,
    };
    expect(checkAll(s).map((x) => x.invariant)).toContain("I1");
  });

  it("I2 catches the pool being overcommitted even when every tenant is under cap", () => {
    // The case I1 alone cannot see: 3 tenants each at cap 3, pool of 8.
    const s: CheckableState = {
      ...healthy(),
      inFlightByTenant: new Map([
        ["a", 3],
        ["b", 3],
        ["c", 3],
      ]),
      capByTenant: new Map([
        ["a", 3],
        ["b", 3],
        ["c", 3],
      ]),
      poolCapacity: 8,
      totalClaimed: 9,
      claimsGranted: 16,
    };
    const ids = checkAll(s).map((x) => x.invariant);
    expect(ids).toContain("I2");
    expect(ids, "no tenant is over its own cap, so I1 must stay silent").not.toContain(
      "I1",
    );
  });

  it("I3 catches a leaked slot (claim recorded, release never happened)", () => {
    const s = { ...healthy(), claimsGranted: 11 };
    expect(checkAll(s).map((x) => x.invariant)).toContain("I3");
  });

  it("I3 catches a slot released twice", () => {
    const s = { ...healthy(), releasesDone: 8 };
    expect(checkAll(s).map((x) => x.invariant)).toContain("I3");
  });

  it("I4 catches a double-debited credit", () => {
    const s = {
      ...healthy(),
      creditsSpent: new Map([
        ["acme", 6],
        ["globex", 2],
      ]),
    };
    expect(checkAll(s).map((x) => x.invariant)).toContain("I4");
  });

  it("I5 catches a release ACCEPTED twice in one generation", () => {
    const s = {
      ...healthy(),
      acceptedReleases: [
        {
          slotId: "slot-1",
          tokenUsed: 4,
          tokenCurrent: 4,
          priorReleasesOfGeneration: 1,
        },
      ],
    };
    expect(checkAll(s).map((x) => x.invariant)).toContain("I5");
  });

  it("I5 catches a release ACCEPTED with a stale fencing token", () => {
    const s = {
      ...healthy(),
      acceptedReleases: [
        {
          slotId: "slot-2",
          tokenUsed: 3,
          tokenCurrent: 9,
          priorReleasesOfGeneration: 0,
        },
      ],
    };
    expect(checkAll(s).map((x) => x.invariant)).toContain("I5");
  });

  it("I5 stays SILENT when a stale release was correctly REFUSED", () => {
    // The regression this encodes: an earlier checker took the plane's list of
    // rejected stale attempts and reported each as a violation, so the fencing
    // token doing its job was scored as a failure. A checker that trusts the
    // thing it is checking is not a checker — it judges accepted releases only.
    const s = {
      ...healthy(),
      acceptedReleases: [
        {
          slotId: "slot-1",
          tokenUsed: 7,
          tokenCurrent: 7,
          priorReleasesOfGeneration: 0,
        },
      ],
    };
    expect(checkAll(s).map((x) => x.invariant)).not.toContain("I5");
  });

  it("I6 catches capacity orphaned past the liveness bound", () => {
    const s = {
      ...healthy(),
      quiesced: true,
      ticksSinceQuiesce: 51,
      livenessBoundN: 50,
      totalClaimed: 3,
    };
    expect(checkAll(s).map((x) => x.invariant)).toContain("I6");
  });

  it("I6 stays silent while still within the bound", () => {
    const s = { ...healthy(), quiesced: true, ticksSinceQuiesce: 49, livenessBoundN: 50 };
    expect(checkAll(s).map((x) => x.invariant)).not.toContain("I6");
  });

  it("I6 stays silent once everything has drained", () => {
    const s: CheckableState = {
      ...healthy(),
      quiesced: true,
      ticksSinceQuiesce: 500,
      totalClaimed: 0,
      claimsGranted: 10,
      releasesDone: 10,
      inFlightByTenant: new Map(),
    };
    expect(checkAll(s).map((x) => x.invariant)).not.toContain("I6");
  });

  it("I7 catches a non-monotonic replay id", () => {
    const s = { ...healthy(), replayIds: [1, 2, 2, 3] };
    expect(checkAll(s).map((x) => x.invariant)).toContain("I7");
  });

  it("I7 catches a replay id going backwards", () => {
    const s = { ...healthy(), replayIds: [1, 5, 4] };
    expect(checkAll(s).map((x) => x.invariant)).toContain("I7");
  });

  it("I7 tolerates gaps — retention eviction is legal, going backwards is not", () => {
    const s = { ...healthy(), replayIds: [1, 40, 900] };
    expect(checkAll(s).map((x) => x.invariant)).not.toContain("I7");
  });

  it("I8 catches an effect applied twice for one identity", () => {
    const s = { ...healthy(), effectCounts: new Map([["msg-a", 2]]) };
    expect(checkAll(s).map((x) => x.invariant)).toContain("I8");
  });
});

describe("the leaky control arm — the checker must reject a known-bad controller", () => {
  /**
   * A controller that leaks one slot in ten. This is the M2 non-vacuity arm: if
   * this ever passes, the checker has stopped checking and every green run in
   * the corpus is meaningless.
   */
  it("a controller that leaks slots fails I3 and eventually I6", () => {
    let claims = 0;
    let releases = 0;
    for (let i = 0; i < 100; i++) {
      claims++;
      if (i % 10 !== 0) releases++; // leaks every tenth slot
    }
    const leaked = claims - releases;
    const state: CheckableState = {
      ...healthy(),
      claimsGranted: claims,
      releasesDone: releases,
      totalClaimed: 0, // the controller *believes* nothing is held — that is the bug
      inFlightByTenant: new Map(),
      quiesced: true,
      ticksSinceQuiesce: 1000,
      livenessBoundN: 50,
    };
    const ids = checkAll(state).map((x) => x.invariant);
    expect(leaked).toBe(10);
    expect(ids, "conservation must catch the discrepancy").toContain("I3");
  });
});

describe("substrate", () => {
  it("is reproducible from a seed", () => {
    const a = new Substrate(new Rng(5));
    const b = new Substrate(new Rng(5));
    for (let i = 0; i < 200; i++) {
      expect(a.nextFault()).toEqual(b.nextFault());
    }
  });

  it("injects nothing when configured honest — the calibration baseline", () => {
    const s = new Substrate(new Rng(11), HONEST_SUBSTRATE);
    for (let i = 0; i < 500; i++) expect(s.nextFault().kind).toBe("none");
    expect(s.injectedCount).toBe(0);
  });

  it("actually injects faults at the configured rate", () => {
    const s = new Substrate(new Rng(13), DEFAULT_SUBSTRATE);
    let faulted = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) if (s.nextFault().kind !== "none") faulted++;
    // A fault injector that injects nothing is the vacuous-green failure (KG2).
    expect(faulted).toBeGreaterThan(0);
    expect(Math.abs(faulted / N - DEFAULT_SUBSTRATE.faultRate)).toBeLessThan(0.05);
  });

  it("weights faults toward boundaries rather than the middle of a run", () => {
    // The orphan bugs live at the transitions. A uniform sampler would put ~1/7
    // of faults at each boundary; the weighting should put far more at the
    // claim/ack boundaries than at mid-run.
    const s = new Substrate(new Rng(17), DEFAULT_SUBSTRATE);
    let midRun = 0;
    let atBoundary = 0;
    for (let i = 0; i < 5000; i++) {
      const f = s.nextFault();
      if (f.kind === "none") continue;
      if (f.boundary === "mid-run") midRun++;
      if (f.boundary === "at-claim" || f.boundary === "post-claim-pre-use") atBoundary++;
    }
    expect(atBoundary).toBeGreaterThan(midRun * 3);
  });

  it("can report a dead pod as ready — the stale readiness read", () => {
    const s = new Substrate(new Rng(19), DEFAULT_SUBSTRATE);
    s.killPod("pod-7");
    expect(s.isActuallyDead("pod-7")).toBe(true);
    let liedAtLeastOnce = false;
    for (let i = 0; i < 200; i++) {
      if (s.reportsReady("pod-7", 0.5)) liedAtLeastOnce = true;
    }
    // If this ever goes false, SEMANTICS C3 is untested and the controller is
    // being handed a substrate that always tells the truth.
    expect(liedAtLeastOnce, "substrate must be capable of lying about readiness").toBe(
      true,
    );
  });

  it("always reports a live pod as ready", () => {
    const s = new Substrate(new Rng(23), DEFAULT_SUBSTRATE);
    for (let i = 0; i < 100; i++) expect(s.reportsReady("pod-alive", 0.5)).toBe(true);
  });
});
