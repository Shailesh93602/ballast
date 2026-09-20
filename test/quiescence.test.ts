import { describe, it, expect } from "vitest";
import { DEFAULT_CONTROL_PLANE } from "../src/policy/types.js";
import { Rng } from "../src/core/rng.js";
import { Substrate, DEFAULT_SUBSTRATE } from "../src/sim/substrate.js";
import { checkAll } from "../src/oracle/invariants.js";
import { DrivenPlane, LIVENESS_BOUND_N } from "./support/planeHarness.js";

/**
 * I6 — BOUNDED LIVENESS, AND THE CALIBRATION IT WAS MISSING.
 *
 * SEMANTICS F3 says the liveness bound N is "calibrated from the corpus, then
 * asserted from BOTH sides: the observed max must be ≤ N and ≥ 0.5·N", and its
 * `Else` clause says a hand-picked generous N makes I6 vacuous — "it passes
 * because it can never fail, which is worse than not having it".
 *
 * The `Else` clause was what was actually happening. Every caller hardcoded
 * `livenessBoundN`, every corpus passed `quiesced: false` on every event, and
 * `checkI6` therefore returned on its first line for all 2,000 histories. The
 * checker could fire — `invariants.test.ts` proves it against synthetic states —
 * but nothing drove it. I6 had never fired on a real run.
 *
 * THE THING THAT MADE THIS HARDER THAN IT LOOKS, and the reason it is worth
 * reading: under SEMANTICS C5 reclamation is LAZY — there is no sweeper, and an
 * expired lease is reclaimed by "the next claimant". So if the workload simply
 * stops, nothing reclaims anything and in-flight NEVER reaches zero. I6's
 * "drains within N ticks" is not merely uncalibrated in that world, it is
 * FALSE. Measured directly: admit one run, advance ten thousand ticks, call
 * nothing — `totalClaimed` is still 1.
 *
 * So quiescence here means what it means operationally: **new work stops, the
 * system keeps being asked.** Each tick of the drain issues one request, and
 * `admit` reclaims expired leases before it does anything else — including
 * before it looks the tenant up, so a REFUSED request drives reclamation just
 * as well as a granted one. That is C5's "next claimant" in its weakest
 * possible form, it adds no fourth operation and no sweeper, and
 * `controlPlane.test.ts` pins the ordering it depends on.
 *
 * N is then derived from the measurement, in `boundFrom` below, rather than
 * chosen.
 */

interface Op {
  readonly kind: "admit" | "release" | "complete" | "cancel";
  readonly vtime: number;
  readonly tenant: string;
  readonly runId: string;
}

function workload(rng: Rng, length: number): Op[] {
  const tenants = DEFAULT_CONTROL_PLANE.tenants.map((t) => t.id);
  const ops: Op[] = [];
  const live: Array<{ runId: string; tenant: string }> = [];
  let vtime = 0;
  for (let i = 0; i < length; i++) {
    vtime += rng.nextInt(0, 4);
    const roll = rng.nextInt(0, 100);
    if (roll < 55 || live.length === 0) {
      const tenant = tenants[rng.nextInt(0, tenants.length)] as string;
      ops.push({ kind: "admit", vtime, tenant, runId: `r${i}` });
      live.push({ runId: `r${i}`, tenant });
    } else {
      const idx = rng.nextInt(0, live.length);
      const run = live[idx] as { runId: string; tenant: string };
      live.splice(idx, 1);
      const kind = roll < 78 ? "complete" : roll < 92 ? "release" : "cancel";
      ops.push({ kind, vtime, tenant: run.tenant, runId: run.runId });
    }
  }
  return ops;
}

/**
 * Drop the terminal operation of some runs, so the drain has real work to do.
 *
 * Without this the workload tidies up after itself and almost every seed is
 * already at zero when the faults stop — the drain would be measuring nothing,
 * which is the vacuity this whole exercise is about. `pod-death` in the
 * substrate models exactly this: the worker died, the admit happened, the
 * terminal op never arrives, and the slot is orphaned until its lease expires.
 */
function killSomeWorkers(ops: readonly Op[], substrate: Substrate): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    const fault = substrate.nextFault();
    if (fault.kind === "pod-death" && op.kind !== "admit") continue;
    out.push(op);
  }
  return out;
}

/** How long, in ticks after quiescence, until the pool is empty. */
interface Drain {
  readonly ticks: number;
  readonly orphansAtQuiesce: number;
  readonly violations: string[];
}

const DRAIN_CEILING = 500;

function runToQuiescence(seed: number, boundN: number): Drain {
  const rng = new Rng(seed);
  const substrate = new Substrate(rng.fork("faults"), DEFAULT_SUBSTRATE);
  const ops = killSomeWorkers(workload(rng.fork("workload"), 120), substrate);

  const d = new DrivenPlane(DEFAULT_CONTROL_PLANE);
  let vtime = 0;
  for (const op of ops) {
    vtime = op.vtime;
    if (op.kind === "admit") d.admit(op.vtime, op.tenant, op.runId);
    else if (op.kind === "release") d.release(op.vtime, op.runId);
    else if (op.kind === "complete") d.complete(op.vtime, op.runId);
    else d.cancel(op.vtime, op.runId);
  }

  const orphansAtQuiesce = d.plane.totalClaimed;
  const violations: string[] = [];
  let ticks = 0;

  // The drain. New work has stopped; requests keep arriving.
  while (ticks < DRAIN_CEILING) {
    ticks++;
    d.probe(vtime + ticks);
    const found = checkAll(
      d.state(vtime + ticks, {
        quiesced: true,
        ticksSinceQuiesce: ticks,
        livenessBoundN: boundN,
      }),
    );
    for (const v of found) violations.push(`${v.invariant}: ${v.detail}`);
    if (d.plane.totalClaimed === 0) break;
  }

  return { ticks, orphansAtQuiesce, violations };
}

/**
 * N, DERIVED FROM THE MEASUREMENT.
 *
 * The smallest multiple of ten strictly above the observed max. "Strictly
 * above" so a healthy run has one tick of headroom rather than sitting exactly
 * on the boundary; a multiple of ten so the published figure is stable against
 * a one-tick wobble in the workload. Both halves of F3 are then asserted
 * against it, which is what stops this from being a generous number with a
 * formula wrapped round it.
 */
function boundFrom(observedMax: number): number {
  return Math.ceil((observedMax + 1) / 10) * 10;
}

const SEEDS = 200;

describe("quiescence — the corpus that makes I6 fire", () => {
  const drains = Array.from({ length: SEEDS }, (_, i) =>
    runToQuiescence(i + 1, LIVENESS_BOUND_N),
  );
  const observedMax = Math.max(...drains.map((d) => d.ticks));
  const withOrphans = drains.filter((d) => d.orphansAtQuiesce > 0).length;

  it("the drain is not vacuous — seeds really do quiesce with capacity held", () => {
    // If every seed tidied up before quiescence, ticks-to-drain would be 1 for
    // all of them and the "calibration" would be calibrating nothing. This is
    // the same check as "the fault injector is actually connected".
    expect(
      withOrphans,
      "no seed reaches quiescence still holding a slot, so the drain measures " +
        "nothing and N is not calibrated against anything",
    ).toBeGreaterThan(SEEDS / 4);
    expect(observedMax, "the longest drain must take real time").toBeGreaterThan(1);
  });

  it("nothing is orphaned past the lease — I6 holds across the drain", () => {
    const failures = drains
      .flatMap((d, i) => d.violations.map((v) => `seed ${i + 1}: ${v}`))
      .slice(0, 5);
    expect(failures, "invariant violations during the drain").toEqual([]);
  });

  it("N is the value the measurement produces — SEMANTICS F3, both sides", () => {
    expect(
      LIVENESS_BOUND_N,
      `the corpus's longest drain is ${observedMax} ticks, so the derived ` +
        `bound is ${boundFrom(observedMax)} — update LIVENESS_BOUND_N, and ` +
        `docs/SEMANTICS.md F3 with it`,
    ).toBe(boundFrom(observedMax));

    // F3's upper side: a healthy run must finish inside the bound, or I6 fires
    // on a correct system.
    expect(observedMax, "the observed max must fit inside N").toBeLessThanOrEqual(
      LIVENESS_BOUND_N,
    );
    // F3's lower side, and the one that matters: a bound far above anything the
    // corpus produces cannot fail, and an invariant that cannot fail is worse
    // than no invariant because it reads as coverage.
    expect(
      observedMax,
      `N=${LIVENESS_BOUND_N} is more than twice the longest observed drain ` +
        `(${observedMax}) — I6 would be unable to fail`,
    ).toBeGreaterThanOrEqual(LIVENESS_BOUND_N / 2);
  });

  it("the bound is the LEASE, and says so — a drain cannot outlast it", () => {
    // What actually bounds the drain is C5 plus the lease: the last claim made
    // before quiescence expires `leaseTicks` later, and the next arriving
    // request reclaims it. Stating the mechanism means the number is
    // explainable rather than merely measured.
    expect(observedMax).toBeLessThanOrEqual(DEFAULT_CONTROL_PLANE.leaseTicks + 1);
  });

  it("I6 CAN fail here — a bound below the real drain is caught", () => {
    // Non-vacuity of the whole apparatus. If this passes silently, the drain
    // harness is not driving I6 at all and every green run above is worthless.
    const tooTight = runToQuiescence(
      drains.findIndex((d) => d.ticks === observedMax) + 1,
      1,
    );
    expect(
      tooTight.violations.filter((v) => v.startsWith("I6")).length,
      "a liveness bound of 1 tick must produce I6 violations on a real drain",
    ).toBeGreaterThan(0);
  });

  it("I6 catches capacity that is genuinely orphaned, not merely slow", () => {
    // A lease long enough that nothing is ever reclaimed is the real failure
    // I6 exists for: capacity held by work that will never report back.
    const d = new DrivenPlane({ ...DEFAULT_CONTROL_PLANE, leaseTicks: 1_000_000 });
    d.admit(0, "acme", "stuck");
    const found = checkAll(
      d.state(500, { quiesced: true, ticksSinceQuiesce: 500, livenessBoundN: 50 }),
    );
    expect(found.map((v) => v.invariant)).toContain("I6");
  });
});
