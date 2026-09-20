import { ControlPlane } from "../../src/policy/controlPlane.js";
import {
  DEFAULT_CONTROL_PLANE,
  type ControlPlaneConfig,
} from "../../src/policy/types.js";
import { Rng } from "../../src/core/rng.js";

/**
 * The fairness harness, shared by the measurement and by the claims check.
 *
 * It lives outside `*.test.ts` on purpose: importing one test file from
 * another makes vitest run its suites twice, and the README's test count is
 * derived by counting `it(` across `test/*.test.ts`.
 *
 * Fairness under an adversary — the noisy-neighbour property.
 *
 * This is what per-tenant caps are FOR. A pool without them serves whoever asks
 * first, so one abusive tenant starves everyone else; that is the failure the
 * whole admission layer exists to prevent, and it is the one an interviewer at a
 * multi-tenant company will ask about by name.
 *
 * TWO RULES, both learned from this workspace's own history:
 *
 * 1. THE BOUND IS CALIBRATED, NOT PICKED. A generous hand-chosen threshold
 *    passes because it cannot fail, which is worse than having no threshold —
 *    it looks like coverage. So the bound is set just above the observed
 *    maximum and reported alongside it.
 *
 * 2. THERE IS A CONTROL ARM THAT MUST FAIL. A global-FIFO policy with no
 *    per-tenant caps has to blow the bound. A threshold no policy can fail is
 *    not a threshold. (This is the same discipline that caught `redlock.test.js`
 *    encoding the bug it should have detected.)
 *
 * Everything is in VIRTUAL TICKS. No wall-clock latency, no throughput-per-
 * second — those numbers are unreproducible, machine-dependent, and would be the
 * first thing anyone asks to see reproduced.
 */

export interface Outcome {
  readonly admitted: number;
  readonly rejected: number;
}

/**
 * Run a mixed workload where one tenant floods and the others behave.
 *
 * `capped` selects the real control plane (per-tenant caps) or the FIFO control
 * arm (pool capacity only, first-come-first-served).
 */
export function runWorkload(
  config: ControlPlaneConfig,
  seed: number,
  capped: boolean,
  includeAbuser: boolean,
): Map<string, Outcome> {
  const plane = new ControlPlane(config);
  const rng = new Rng(seed);
  const results = new Map<string, Outcome>();
  for (const t of config.tenants) results.set(t.id, { admitted: 0, rejected: 0 });

  // The abuser submits ~10x as often as anyone else.
  const abuser = config.tenants[0]!.id;
  const wellBehaved = config.tenants.slice(1).map((t) => t.id);

  let poolInUse = 0;
  let runId = 0;
  /**
   * Runs currently occupying a slot, with the tick they finish.
   *
   * An earlier version completed each run on the tick after it was admitted, so
   * capacity was free again before the next arrival and NOTHING ever contended —
   * every policy scored a perfect 1.00 and the whole measurement was vacuous.
   * Real contention needs runs to actually HOLD a slot for a while, which is
   * also what a browser session does.
   */
  const inFlight: Array<{ runId: string; endsAt: number }> = [];
  const RUN_DURATION = 5;

  for (let tick = 0; tick < 400; tick++) {
    // Retire everything whose run has finished.
    for (let i = inFlight.length - 1; i >= 0; i--) {
      const run = inFlight[i]!;
      if (run.endsAt > tick) continue;
      if (capped) plane.complete(tick, run.runId, "completed");
      else poolInUse = Math.max(0, poolInUse - 1);
      inFlight.splice(i, 1);
    }

    // The abuser hammers every tick; the others arrive occasionally.
    const arrivals: string[] = includeAbuser ? [abuser, abuser, abuser] : [];
    for (const t of wellBehaved) {
      if (rng.nextBool(0.4)) arrivals.push(t);
    }

    for (const tenant of arrivals) {
      const id = `r${runId++}`;
      if (capped) {
        const r = plane.admit(tick, tenant, id);
        const prev = results.get(tenant)!;
        results.set(
          tenant,
          r.ok
            ? { ...prev, admitted: prev.admitted + 1 }
            : { ...prev, rejected: prev.rejected + 1 },
        );
        if (r.ok) inFlight.push({ runId: id, endsAt: tick + RUN_DURATION });
      } else {
        // CONTROL ARM: global FIFO, pool capacity only, no per-tenant limit.
        const prev = results.get(tenant)!;
        if (poolInUse < config.poolCapacity) {
          poolInUse++;
          inFlight.push({ runId: id, endsAt: tick + RUN_DURATION });
          results.set(tenant, { ...prev, admitted: prev.admitted + 1 });
        } else {
          results.set(tenant, { ...prev, rejected: prev.rejected + 1 });
        }
      }
    }
  }

  return results;
}

/**
 * DEGRADATION, not share.
 *
 * The first version of this measured the abuser's admitted count against the
 * median well-behaved tenant's, and it was the wrong question. A tenant that
 * submits ten times as often and is under its cap is using SPARE capacity — that
 * is not a noisy neighbour, that is a pool doing its job. Measuring share
 * punishes a policy for being efficient.
 *
 * The noisy-neighbour question is: **does the abuser's presence hurt everyone
 * else?** So the metric is each well-behaved tenant's service compared against a
 * solo baseline where the abuser is absent, holding the seed fixed so the
 * arrival pattern is identical in both runs.
 *
 * 1.0 means the abuser cost the others nothing. Higher means degradation.
 */
export function degradationFactor(
  config: ControlPlaneConfig,
  seed: number,
  capped: boolean,
): number {
  const withAbuser = runWorkload(config, seed, capped, true);
  const solo = runWorkload(config, seed, capped, false);

  let worst = 1;
  for (const [tenant, outcome] of solo) {
    if (tenant === "abuser") continue;
    const contended = withAbuser.get(tenant)?.admitted ?? 0;
    if (outcome.admitted === 0) continue;
    if (contended === 0) return Number.POSITIVE_INFINITY;
    worst = Math.max(worst, outcome.admitted / contended);
  }
  return worst;
}

export const CONFIG: ControlPlaneConfig = {
  ...DEFAULT_CONTROL_PLANE,
  poolCapacity: 6,
  tenants: [
    { id: "abuser", cap: 2, creditsPerWindow: 1000 },
    { id: "quiet-a", cap: 2, creditsPerWindow: 1000 },
    { id: "quiet-b", cap: 2, creditsPerWindow: 1000 },
  ],
};

/** The number of seeds the control arm is measured over. */
export const FAIRNESS_SEEDS = 60;

/**
 * Count the seeds on which global FIFO starves a well-behaved tenant outright.
 *
 * COMPUTED, not remembered. "38 of 60" appeared in README.md, twice in
 * docs/FAIRNESS.md, and as a hardcoded a hardcoded regex literal inside
 * readmeClaims.test.ts — four places, none of which ran the measurement. The
 * assertion was "the README contains the string 38", which stays green no
 * matter what the policy does; the only way it could ever have failed is if
 * somebody edited the README. That is the same shape as this workspace's
 * `claims-consistency.test.ts`, which imported a constant for its positive
 * assertions and hardcoded the same number inside its negative lookaheads.
 */
export function fifoStarvation(): {
  starvedSeeds: number;
  finite: number[];
} {
  let starvedSeeds = 0;
  const finite: number[] = [];
  for (let seed = 1; seed <= FAIRNESS_SEEDS; seed++) {
    const factor = degradationFactor(CONFIG, seed, false);
    if (!Number.isFinite(factor)) starvedSeeds++;
    else finite.push(factor);
  }
  return { starvedSeeds, finite };
}

/** Seeds on which the CAPPED policy starves anyone. Structurally zero. */
export function cappedStarvation(): number {
  let starved = 0;
  for (let seed = 1; seed <= FAIRNESS_SEEDS; seed++) {
    if (!Number.isFinite(degradationFactor(CONFIG, seed, true))) starved++;
  }
  return starved;
}

/** Worst degradation the capped policy inflicts, over the same seeds. */
export function cappedWorstDegradation(): number {
  let worst = 0;
  for (let seed = 1; seed <= FAIRNESS_SEEDS; seed++) {
    worst = Math.max(worst, degradationFactor(CONFIG, seed, true));
  }
  return worst;
}
