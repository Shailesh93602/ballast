import { describe, it, expect } from "vitest";
import { ControlPlane } from "../src/policy/controlPlane.js";
import { DEFAULT_CONTROL_PLANE, type ControlPlaneConfig } from "../src/policy/types.js";
import { ReplayLog } from "../src/policy/replayLog.js";
import { checkAll, type CheckableState } from "../src/oracle/invariants.js";

/**
 * Control-plane behaviour, asserted against docs/SEMANTICS.md.
 *
 * Every test names the row it enforces. That mapping is the point: a test with
 * no row behind it is testing whatever the implementation happened to do, which
 * is how a suite ends up ratifying a bug (see this workspace's redlock.test.js,
 * which encoded the very behaviour it should have caught).
 */

function cp(overrides: Partial<ControlPlaneConfig> = {}): ControlPlane {
  return new ControlPlane({ ...DEFAULT_CONTROL_PLANE, ...overrides });
}

/** Snapshot the plane into the shape the invariant checker consumes. */
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
    // The independent recomputation, NOT `creditsSpentMap()` a second time —
    // aliasing the two made I4 compare a map to itself, so it could not fire.
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

describe("admission — caps (SEMANTICS B1, B2, B3)", () => {
  it("B1: the cap counts CLAIMED slots, and holds", () => {
    const plane = cp();
    for (let i = 0; i < 3; i++) {
      expect(plane.admit(0, "acme", `r${i}`).ok, `admit ${i}`).toBe(true);
    }
    const over = plane.admit(0, "acme", "r3");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("cap-exceeded");
  });

  it("B2: the cap is never exceeded, even across many interleaved admits", () => {
    const plane = cp();
    for (let i = 0; i < 50; i++) plane.admit(0, "acme", `r${i}`);
    expect(plane.inFlightByTenant().get("acme")).toBeLessThanOrEqual(3);
    expect(checkAll(stateOf(plane, 0))).toEqual([]);
  });

  it("B3/B4: the two rejection reasons are distinguishable (B5)", () => {
    // acme at cap while the pool still has room -> cap-exceeded
    const plane = cp();
    for (let i = 0; i < 3; i++) plane.admit(0, "acme", `a${i}`);
    const capped = plane.admit(0, "acme", "a-extra");
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.reason).toBe("cap-exceeded");

    // Fill the pool from other tenants -> pool-full for someone under cap
    plane.admit(0, "globex", "g0");
    plane.admit(0, "globex", "g1");
    plane.admit(0, "initech", "i0");
    const poolFull = plane.admit(0, "initech", "i1");
    expect(poolFull.ok).toBe(false);
    if (!poolFull.ok) expect(poolFull.reason).toBe("pool-full");
  });

  it("rejects an unknown tenant rather than inventing a cap", () => {
    const plane = cp();
    const r = plane.admit(0, "nobody", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown-tenant");
  });

  it("never overcommits the pool across all tenants (I2)", () => {
    const plane = cp();
    for (let i = 0; i < 20; i++) {
      plane.admit(0, "acme", `a${i}`);
      plane.admit(0, "globex", `g${i}`);
      plane.admit(0, "initech", `i${i}`);
    }
    expect(plane.totalClaimed).toBeLessThanOrEqual(DEFAULT_CONTROL_PLANE.poolCapacity);
    expect(checkAll(stateOf(plane, 0))).toEqual([]);
  });
});

describe("credit (SEMANTICS A1, A2, A3)", () => {
  it("A3: credit is debited at CLAIM, not at admit-attempt", () => {
    const plane = cp();
    // Rejected admits must not spend credit.
    for (let i = 0; i < 10; i++) plane.admit(0, "acme", `r${i}`);
    const spent = plane.creditsSpentMap().get("acme") ?? 0;
    // Only 3 could be claimed (cap), so only 3 credits may have moved.
    expect(spent).toBe(3);
  });

  it("A1/A2: the window tumbles, restoring the budget", () => {
    const plane = cp({
      poolCapacity: 12,
      tenants: [{ id: "solo", cap: 12, creditsPerWindow: 2 }],
    });
    expect(plane.admit(0, "solo", "r0").ok).toBe(true);
    expect(plane.admit(0, "solo", "r1").ok).toBe(true);
    const denied = plane.admit(0, "solo", "r2");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("no-credit");

    // Cross into the next tumbling window.
    const next = DEFAULT_CONTROL_PLANE.windowTicks;
    expect(plane.admit(next, "solo", "r3").ok, "budget restored in the new window").toBe(
      true,
    );
  });

  it("I4: the independent recomputation is window-scoped, like the counter it checks", () => {
    // `creditsSpent` resets on every roll, so a recomputation that counts runs
    // across ALL windows measures a different quantity and I4 fires the moment
    // a boundary is crossed. It agreed for one reason only: nothing ever
    // crossed one. Corpus histories topped out at tick 85 against a window of
    // 100, and the corpus passed `creditsSpentMap()` as both sides of I4.
    const plane = cp();
    plane.admit(0, "acme", "w0-a");
    plane.admit(1, "acme", "w0-b");
    plane.complete(2, "w0-a", "completed");
    plane.complete(3, "w0-b", "completed");

    const next = DEFAULT_CONTROL_PLANE.windowTicks + 20;
    plane.admit(next, "acme", "w1-a");

    expect(plane.creditsSpentMap().get("acme"), "one claim in this window").toBe(1);
    expect(
      plane.creditsExpected().get("acme"),
      "the recomputation must count this window too, not every window ever",
    ).toBe(1);
    expect(checkAll(stateOf(plane, next))).toEqual([]);
  });
});

describe("leases and fencing (SEMANTICS C1, C2, C4)", () => {
  it("C1: fencing tokens are globally monotonic", () => {
    const plane = cp();
    const a = plane.admit(0, "acme", "a");
    const b = plane.admit(0, "globex", "b");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.token).toBeGreaterThan(a.token);
  });

  it("rejects a release carrying a stale token, and records it (I5)", () => {
    const plane = cp();
    const first = plane.admit(0, "acme", "a");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Lease expires; the slot is reclaimed and handed to someone else.
    const afterExpiry = DEFAULT_CONTROL_PLANE.leaseTicks + 1;
    const second = plane.admit(afterExpiry, "globex", "b");
    expect(second.ok).toBe(true);

    // The original holder now tries to release the slot it no longer owns.
    const stale = plane.release(afterExpiry, first.slotId, first.token);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("stale-token");
    expect(
      plane.counters.staleReleaseAttempts,
      "the attempt should be counted for observability, but refusing it is correct behaviour, not a violation",
    ).toBeGreaterThan(0);
  });

  /**
   * C1/C4 applies to EVERY path that frees a slot, not just `release()`.
   *
   * `release()` has always validated the fencing token. `complete()` and
   * `cancel()` used to free the slot named by `run.slotId` without one — so
   * after a lease expired and the slot was re-claimed by a different tenant, a
   * stale complete or cancel evicted the live owner. Nothing caught it: I1 and
   * I2 only fire when the pool goes OVER its bounds and this pushes it under,
   * I3 stayed balanced because `releasesDone` was incremented alongside, and I5
   * was fed only by `release()`, so it never saw these two doors at all.
   */
  function twoTenantsOneSlot(): ControlPlane {
    return new ControlPlane({
      tenants: [
        { id: "alice", cap: 2, creditsPerWindow: 100 },
        { id: "bob", cap: 2, creditsPerWindow: 100 },
      ],
      poolCapacity: 1,
      windowTicks: 100_000,
      leaseTicks: 10,
      retentionCount: 64,
      retentionTicks: 500,
    });
  }

  it("C1/C4: a stale COMPLETE must not evict the slot's current owner", () => {
    const plane = twoTenantsOneSlot();
    const alice = plane.admit(0, "alice", "A");
    expect(alice.ok).toBe(true);
    // Alice's lease runs to t=10. Bob claims the reclaimed slot at t=20.
    const bob = plane.admit(20, "bob", "B");
    expect(bob.ok, "bob takes the reclaimed slot").toBe(true);
    if (!alice.ok || !bob.ok) return;
    expect(bob.token, "a re-claim issues a new token").toBeGreaterThan(alice.token);

    // Alice's stale release is refused — that path was always fenced.
    const staleRelease = plane.release(21, alice.slotId, alice.token);
    expect(staleRelease.ok).toBe(false);

    // The same staleness arriving as a completion must be refused too.
    const before = plane.counters.staleReleaseAttempts;
    plane.complete(22, "A", "completed");
    expect(
      plane.inFlightByTenant().get("bob"),
      "bob still holds the slot he legitimately claimed",
    ).toBe(1);
    // And the refusal must be RECORDED, not merely performed. Mechanical
    // mutation found this gap in the fix itself: deleting the counter bump in
    // `freeSlotOf` changed nothing observable, because the assertions above
    // only checked that bob kept his slot. A stale claim silently refused is
    // an operator's only evidence that the fence is load-bearing.
    expect(
      plane.counters.staleReleaseAttempts,
      "a stale completion refused by the fence must be counted, like a stale release",
    ).toBe(before + 1);
    expect(
      plane.release(23, bob.slotId, bob.token).ok,
      "bob can still release his own slot",
    ).toBe(true);
  });

  it("C1/C4: a stale CANCEL must not evict the slot's current owner", () => {
    const plane = twoTenantsOneSlot();
    const alice = plane.admit(0, "alice", "A");
    const bob = plane.admit(20, "bob", "B");
    expect(alice.ok && bob.ok).toBe(true);

    const before = plane.counters.staleReleaseAttempts;
    plane.cancel(22, "A");
    expect(
      plane.inFlightByTenant().get("bob"),
      "cancelling a lease-expired run must not free somebody else's slot",
    ).toBe(1);
    expect(
      plane.counters.staleReleaseAttempts,
      "and the cancel path records its refusal too",
    ).toBe(before + 1);
  });

  it("I5 judges every path that frees a slot, not only release()", () => {
    // Non-vacuity for the fix above: if complete()/cancel() stopped reporting
    // their releases as facts, I5 would go back to being blind to two thirds
    // of the surface and this assertion would fail.
    const plane = cp();
    const a = plane.admit(0, "acme", "r1");
    expect(a.ok).toBe(true);
    expect(plane.counters.acceptedReleases).toHaveLength(0);

    plane.complete(1, "r1", "completed");
    expect(
      plane.counters.acceptedReleases,
      "a completion that frees a slot is a release the checker must see",
    ).toHaveLength(1);

    const b = plane.admit(2, "globex", "r2");
    expect(b.ok).toBe(true);
    plane.cancel(3, "r2");
    expect(plane.counters.acceptedReleases).toHaveLength(2);
    expect(checkAll(stateOf(plane, 3)), "all of them are legitimate").toEqual([]);
  });

  it("a valid release succeeds and returns the slot to the pool", () => {
    const plane = cp();
    const a = plane.admit(0, "acme", "a");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(plane.totalClaimed).toBe(1);
    expect(plane.release(1, a.slotId, a.token).ok).toBe(true);
    expect(plane.totalClaimed).toBe(0);
    expect(checkAll(stateOf(plane, 1))).toEqual([]);
  });

  it("C2: an expired lease is reclaimed, freeing capacity", () => {
    const plane = cp();
    for (let i = 0; i < 6; i++) plane.admit(0, i < 3 ? "acme" : "globex", `r${i}`);
    expect(plane.totalClaimed).toBe(6);
    // Past the lease: the next admit reclaims lazily (C5).
    const later = DEFAULT_CONTROL_PLANE.leaseTicks + 1;
    const after = plane.admit(later, "initech", "fresh");
    expect(after.ok, "capacity should have been reclaimed").toBe(true);
  });
});

describe("completion and idempotence (SEMANTICS E7, and I8)", () => {
  it("I8: the effect is applied exactly once however many deliveries arrive", () => {
    const plane = cp();
    const a = plane.admit(0, "acme", "run-1");
    expect(a.ok).toBe(true);

    const first = plane.complete(5, "run-1", "completed");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.duplicate).toBe(false);

    // Eight more deliveries of the same completion.
    for (let i = 0; i < 8; i++) {
      const dup = plane.complete(5 + i, "run-1", "completed");
      expect(dup.ok, "a duplicate must be ACKED, not errored (E7)").toBe(true);
      if (dup.ok) expect(dup.duplicate).toBe(true);
    }

    expect(plane.effectCountsMap().get("run-1")).toBe(1);
    expect(checkAll(stateOf(plane, 20))).toEqual([]);
  });

  it("rejects a completion for a run it has never heard of", () => {
    const plane = cp();
    const r = plane.complete(0, "ghost", "completed");
    expect(r.ok).toBe(false);
  });
});

describe("cancellation (SEMANTICS D1, D2, D4)", () => {
  it("D1: a cancel arriving before the admit makes the admit lose", () => {
    const plane = cp();
    expect(plane.cancel(0, "run-x")).toBe("cancelled");
    const admitted = plane.admit(1, "acme", "run-x");
    expect(admitted.ok).toBe(false);
    if (!admitted.ok) expect(admitted.reason).toBe("cancelled-before-start");
  });

  it("D2: a completion already recorded beats a later cancel", () => {
    const plane = cp();
    plane.admit(0, "acme", "run-y");
    expect(plane.complete(1, "run-y", "completed").ok).toBe(true);
    expect(plane.cancel(2, "run-y")).toBe("already-complete");
  });

  it("D4: cancel is idempotent", () => {
    const plane = cp();
    plane.admit(0, "acme", "run-z");
    expect(plane.cancel(1, "run-z")).toBe("cancelled");
    expect(plane.cancel(2, "run-z")).toBe("noop");
    expect(checkAll(stateOf(plane, 2))).toEqual([]);
  });

  it("E8: a completion after a cancel is recorded but the effect is NOT applied", () => {
    const plane = cp();
    plane.admit(0, "acme", "run-w");
    plane.cancel(1, "run-w");
    const late = plane.complete(2, "run-w", "completed");
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toBe("completed-after-cancel");
    expect(plane.effectCountsMap().get("run-w") ?? 0).toBe(0);
  });
});

describe("replay log (SEMANTICS E1, E2, E3, E5, E6)", () => {
  it("E3/I7: replay ids strictly increase and are never reused", () => {
    const log = new ReplayLog(100, 10_000);
    const ids: number[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(
        log.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" }),
      );
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
    }
  });

  it("E1: retention is bounded by BOTH count and age", () => {
    const byCount = new ReplayLog(5, 10_000);
    for (let i = 0; i < 20; i++) {
      byCount.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" });
    }
    byCount.evict(20);
    expect(byCount.size, "count bound").toBeLessThanOrEqual(5);

    const byAge = new ReplayLog(1000, 10);
    for (let i = 0; i < 20; i++) {
      byAge.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" });
    }
    byAge.evict(100);
    expect(byAge.size, "age bound — everything is older than 10 ticks").toBe(0);
  });

  it("E2: resubscribing below retention is an ERROR, not a silent fast-forward", () => {
    const log = new ReplayLog(5, 10_000);
    for (let i = 0; i < 20; i++) {
      log.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" });
    }
    log.evict(20);
    const result = log.readFrom(1, 10);
    expect(result.ok, "a cursor below retention must not silently jump forward").toBe(
      false,
    );
    if (!result.ok) expect(result.reason).toBe("retention-exceeded");
  });

  it("E2: an EMPTIED log must still report retention-exceeded, not 'nothing new'", () => {
    // The case the partial-eviction test above stepped over. The guard used to
    // read `cursor < oldestRetained && this.entries.length > 0`, so once
    // retention had drained the log to nothing the WORST outcome became the
    // quietest one: a subscriber holding an evicted cursor was told `ok: true,
    // entries: []` for events it had permanently missed — a hole with no way
    // to discover it, which is the exact thing E2 exists to forbid.
    const log = new ReplayLog(1000, 10);
    for (let i = 0; i < 10; i++) {
      log.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" });
    }
    log.evict(100);
    expect(log.size, "everything has aged out").toBe(0);

    const result = log.readFrom(3, 10);
    expect(result.ok, "ids 3..10 are gone; saying 'nothing new' is a lie").toBe(false);
    if (!result.ok) expect(result.reason).toBe("retention-exceeded");
  });

  it("E2: a FRESH subscriber on an empty log is still served normally", () => {
    // The other side of the same guard — tightening it must not break the
    // ordinary case of a subscriber that has simply not missed anything.
    const log = new ReplayLog(1000, 10_000);
    const fresh = log.readFrom(1, 10);
    expect(fresh.ok, "nothing has been evicted, so there is no hole").toBe(true);
    if (fresh.ok) expect(fresh.entries).toEqual([]);

    log.append({ vtime: 0, tenant: "t", runId: "r0", outcome: "completed" });
    const after = log.readFrom(1, 10);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.entries).toHaveLength(1);
  });

  it("E5: a subscriber at zero credit PAUSES — nothing is dropped", () => {
    const log = new ReplayLog(1000, 10_000);
    for (let i = 0; i < 10; i++) {
      log.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" });
    }
    const sub = { name: "slow", cursor: 1, credits: 0, inFlight: 0 };
    expect(log.deliver(sub), "no credit means no delivery").toEqual([]);

    // Grant credit; the entries are STILL THERE. Nothing was dropped while paused.
    sub.credits = 3;
    const got = log.deliver(sub);
    expect(got.length).toBe(3);
    expect(got[0]!.replayId, "delivery resumes exactly where it paused").toBe(1);
  });

  it("E6: credit is consumed on ACK, not on send — so backpressure is real", () => {
    const log = new ReplayLog(1000, 10_000);
    for (let i = 0; i < 10; i++) {
      log.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" });
    }
    const sub = { name: "s", cursor: 1, credits: 2, inFlight: 0 };

    const first = log.deliver(sub);
    expect(first.length).toBe(2);
    // Nothing acked yet: the window is full, so a second delivery sends nothing.
    // This is the whole point — an unresponsive subscriber stops being sent data.
    expect(log.deliver(sub), "unacked entries must hold the window shut").toEqual([]);

    log.acknowledge(sub, 2, 2);
    expect(log.deliver(sub).length, "acking reopens the window").toBe(2);
  });
});
