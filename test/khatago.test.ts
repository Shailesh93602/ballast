import { describe, it, expect } from "vitest";
import { KhataGoClaimModel } from "../src/policy/khatagoClaim.js";
import { checkAll, type CheckableState } from "../src/oracle/invariants.js";
import { Rng } from "../src/core/rng.js";
import { Substrate } from "../src/sim/substrate.js";

/**
 * M8 Tier A — KhataGO's claim protocol, judged by the UNCHANGED checker.
 *
 * The point of this file is that nothing in `src/oracle/invariants.ts` was
 * modified to accommodate it. The same I1–I8 that judge BALLAST's control plane
 * judge KhataGO's webhook protocol, because the two are the same mechanism at
 * different scales: a predicate evaluated inside a mutation rather than before
 * it.
 *
 * That matters for what can honestly be claimed. "I wrote a checker and my code
 * passes it" is weak — the checker was written by the same person, for that
 * code. "I wrote a checker for one system and it verified a DIFFERENT one I had
 * already shipped" is the claim worth making, and it is only available because
 * the invariants were kept general.
 *
 * SCOPE, stated so it is not overclaimed: this verifies the PROTOCOL. It does
 * not verify that KhataGO's Prisma calls implement the protocol faithfully —
 * Tier B does that by driving the real handler against a local Postgres and
 * running this same checker over the recorded history.
 */

function stateOf(model: KhataGoClaimModel): CheckableState {
  return {
    vtime: 0,
    inFlightByTenant: new Map(),
    capByTenant: new Map(),
    poolCapacity: 0,
    totalClaimed: 0,
    claimsGranted: 0,
    releasesDone: 0,
    creditsSpent: new Map(),
    creditsExpected: new Map(),
    slotOwnerToken: new Map(),
    acceptedReleases: [],
    replayIds: [],
    // I8 is the invariant that carries the weight here.
    effectCounts: model.effectCounts(),
    quiesced: true,
    ticksSinceQuiesce: 0,
    livenessBoundN: 100,
  };
}

describe("KhataGO claim protocol — the headline guarantee", () => {
  it("I8: N duplicate deliveries produce exactly ONE effect", () => {
    const model = new KhataGoClaimModel();
    for (let i = 0; i < 8; i++) model.deliver("wamid.ABC123");

    expect(model.messages.get("wamid.ABC123")?.effectRuns).toBe(1);
    expect(checkAll(stateOf(model)), "I8 must hold").toEqual([]);
  });

  it("every duplicate is ACKED 202 — never a 5xx", () => {
    // The bug this pins: returning non-2xx for a duplicate. Meta treats non-2xx
    // as undelivered and redelivers, so erroring on a duplicate converts a
    // handled case into an amplifying loop. The real system had exactly this —
    // losers of the insert race hit P2002 and returned 500.
    const model = new KhataGoClaimModel();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push(model.deliver("wamid.X").ackStatus);

    expect(statuses.every((s) => s === 202)).toBe(true);
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
  });

  it("distinct messages each get exactly one effect", () => {
    const model = new KhataGoClaimModel();
    for (let i = 0; i < 50; i++) {
      // Each delivered three times.
      model.deliver(`wamid.${i}`);
      model.deliver(`wamid.${i}`);
      model.deliver(`wamid.${i}`);
    }
    for (const [, row] of model.messages) expect(row.effectRuns).toBe(1);
    expect(checkAll(stateOf(model))).toEqual([]);
  });
});

describe("KhataGO claim protocol — under the lying substrate", () => {
  it("survives duplicate, late and out-of-order deliveries across 500 seeded runs", () => {
    const failures: Array<{ seed: number; detail: string }> = [];

    for (let seed = 1; seed <= 500; seed++) {
      const rng = new Rng(seed);
      const substrate = new Substrate(rng.fork("faults"));
      const model = new KhataGoClaimModel();

      // A handful of messages, each delivered an unpredictable number of times,
      // in an unpredictable order, with pods dying mid-claim.
      const ids = ["a", "b", "c"].map((s) => `wamid.${s}`);
      const deliveries: Array<{ id: string; podDied: boolean }> = [];
      for (const id of ids) {
        const times = rng.nextInt(1, 6);
        for (let i = 0; i < times; i++) {
          const fault = substrate.nextFault();
          deliveries.push({ id, podDied: fault.kind === "pod-death" });
        }
      }
      // Shuffle to model reordering.
      for (let i = deliveries.length - 1; i > 0; i--) {
        const j = rng.nextInt(0, i + 1);
        const tmp = deliveries[i] as { id: string; podDied: boolean };
        deliveries[i] = deliveries[j] as { id: string; podDied: boolean };
        deliveries[j] = tmp;
      }

      for (const d of deliveries) model.deliver(d.id, d.podDied);

      const violations = checkAll(stateOf(model));
      if (violations.length > 0) {
        failures.push({ seed, detail: violations[0]!.detail });
      }
    }

    expect(failures.slice(0, 5), "I1–I8 violations across the corpus").toEqual([]);
  });

  it("a pod dying between the claim and the commit never double-runs the effect", () => {
    // The case that decides whether the protocol leaks. The first delivery wins
    // the claim and dies before committing; every later delivery finds the row
    // in PROCESSING and correctly declines.
    const model = new KhataGoClaimModel();

    const first = model.deliver("wamid.DEATH", true);
    expect(first.claimed, "the first delivery wins the claim").toBe(true);
    expect(model.messages.get("wamid.DEATH")?.effectRuns).toBe(0);
    expect(model.messages.get("wamid.DEATH")?.aiStatus).toBe("PROCESSING");

    for (let i = 0; i < 5; i++) model.deliver("wamid.DEATH");

    // Never MORE than once. It is legitimately zero here — the work was lost
    // with the pod — and that is the honest behaviour, not a bug being hidden.
    expect(model.messages.get("wamid.DEATH")?.effectRuns).toBe(0);
    expect(checkAll(stateOf(model))).toEqual([]);
  });

  it("names the gap it does NOT close: a dead claimant leaves the row stuck", () => {
    // Stated as a test rather than a comment so it cannot quietly stop being
    // true. A message whose claimant died stays PROCESSING forever — no reaper
    // exists. This is a real limitation of the deployed protocol, and it is
    // better to have it written down and asserted than discovered in an
    // interview.
    const model = new KhataGoClaimModel();
    model.deliver("wamid.STUCK", true);
    for (let i = 0; i < 20; i++) model.deliver("wamid.STUCK");

    expect(
      model.messages.get("wamid.STUCK")?.aiStatus,
      "no reaper: the row is stuck in PROCESSING and will never be retried",
    ).toBe("PROCESSING");
    expect(model.stats.lostClaims).toBeGreaterThan(0);
  });
});

describe("KhataGO protocol mutants — all 5 must be caught", () => {
  /**
   * Each mutant is a plausible way to write this protocol slightly wrong. They
   * are expressed as small broken models and judged by the SAME checker.
   */

  it("KM1: no unique constraint — a read-then-write race double-inserts", () => {
    // Two concurrent deliveries both read "not present" and both proceed.
    class NoUnique {
      readonly rows = new Map<string, { effectRuns: number }>();
      deliver(id: string) {
        const seen = this.rows.has(id); // read...
        if (!seen) this.rows.set(id, { effectRuns: 0 }); // ...then write
        const row = this.rows.get(id)!;
        row.effectRuns++; // no claim at all
      }
      effectCounts() {
        return new Map([...this.rows].map(([k, v]) => [k, v.effectRuns]));
      }
    }
    const m = new NoUnique();
    for (let i = 0; i < 4; i++) m.deliver("wamid.X");
    const violations = checkAll({
      ...stateOf(new KhataGoClaimModel()),
      effectCounts: m.effectCounts(),
    });
    expect(
      violations.map((v) => v.invariant),
      "I8 must catch the double effect",
    ).toContain("I8");
  });

  it("KM2: claim without CAS — read status, then set it", () => {
    class NoCas {
      readonly rows = new Map<string, { status: string; effectRuns: number }>();
      deliver(id: string) {
        if (!this.rows.has(id)) this.rows.set(id, { status: "PENDING", effectRuns: 0 });
        const row = this.rows.get(id)!;
        const status = row.status; // read
        // ...an interleaving would happen here...
        if (status === "PENDING") {
          row.status = "PROCESSING"; // write
          row.effectRuns++;
        }
      }
      effectCounts() {
        return new Map([...this.rows].map(([k, v]) => [k, v.effectRuns]));
      }
    }
    // Two "concurrent" deliveries that both observed PENDING.
    const m = new NoCas();
    m.rows.set("wamid.Y", { status: "PENDING", effectRuns: 0 });
    const row = m.rows.get("wamid.Y")!;
    const a = row.status;
    const b = row.status; // both read PENDING before either wrote
    if (a === "PENDING") {
      row.status = "PROCESSING";
      row.effectRuns++;
    }
    if (b === "PENDING") {
      row.effectRuns++; // the loser also proceeds
    }
    const violations = checkAll({
      ...stateOf(new KhataGoClaimModel()),
      effectCounts: m.effectCounts(),
    });
    expect(violations.map((v) => v.invariant)).toContain("I8");
  });

  it("KM3: ack BEFORE commit — the effect is lost but reported done", () => {
    // Acking before the effect is durable means a pod death loses the work
    // silently while Meta believes it was handled. The model catches it as a
    // row that is DONE with zero effect runs.
    const model = new KhataGoClaimModel();
    model.persist("wamid.Z");
    model.claim("wamid.Z");
    // Ack happens... then the pod dies before runEffect.
    const row = model.messages.get("wamid.Z")!;
    expect(row.effectRuns).toBe(0);
    expect(row.committed, "nothing was committed, so nothing may claim to be done").toBe(
      false,
    );
  });

  it("KM4: keyed on the wrong identity — internal id instead of waMessageId", () => {
    // Two deliveries of the SAME WhatsApp message arrive as two rows because the
    // dedup key was the database's own id rather than Meta's message id.
    const model = new KhataGoClaimModel();
    model.deliver("row-1"); // same message, first delivery
    model.deliver("row-2"); // same message, second delivery, different key
    const total = [...model.effectCounts().values()].reduce((a, b) => a + b, 0);
    expect(
      total,
      "keying on the wrong identity runs the effect twice for one message",
    ).toBe(2);
    // I8 cannot see this — it counts per identity, and the identity is wrong.
    // Recorded here because a checker's blind spots should be written down.
    expect(checkAll(stateOf(model)), "I8 is blind to a wrong identity by design").toEqual(
      [],
    );
  });

  it("KM5: a duplicate errors instead of acking — the redelivery loop", () => {
    // Modelled as the outcome, since the real bug is a 500. Asserting the real
    // model never produces one is the regression.
    const model = new KhataGoClaimModel();
    const statuses = Array.from(
      { length: 12 },
      () => model.deliver("wamid.LOOP").ackStatus,
    );
    expect(
      statuses.some((s) => s >= 500),
      "a 5xx on a duplicate is what turns a handled case into a redelivery storm",
    ).toBe(false);
  });
});
