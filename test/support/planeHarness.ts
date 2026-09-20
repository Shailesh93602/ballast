import { ControlPlane } from "../../src/policy/controlPlane.js";
import type { ControlPlaneConfig, TenantId } from "../../src/policy/types.js";
import type { CheckableState } from "../../src/oracle/invariants.js";
import {
  applyEvent,
  creditsInWindow,
  emptyWorld,
  type RefEvent,
  type World,
} from "../../src/oracle/reference.js";

/**
 * ONE harness, shared by every corpus that drives a `ControlPlane`.
 *
 * It exists because the same `stateOf()` was copy-pasted into five test files,
 * and the copies drifted: two of them passed `creditsSpentMap()` as BOTH sides
 * of I4 (L11), and all five passed `slotOwnerToken: new Map()` for an input the
 * checker declares and nothing wrote (L24). A duplicated oracle wiring is a
 * duplicated place for an oracle to be silently unplugged.
 *
 * The two properties worth stating explicitly:
 *
 * 1. I4's EXPECTED SIDE COMES FROM THE EVENT HISTORY, not from the plane.
 *    `ControlPlane.creditsExpected()` was a method on the class it checked,
 *    walking the same `runs` map `admit` writes — a differential recomputation
 *    between two views of one piece of state, which can only ever disagree
 *    about its own consistency. This harness replays the request stream through
 *    the reference model instead, so a plane whose bookkeeping is wrong in the
 *    SAME direction as its counter is now measurable.
 *
 * 2. THE HISTORY IS THE STREAM OF REQUESTS, not of outcomes. Nothing recorded
 *    here is read back off the plane. The harness forwards a request and
 *    records that it forwarded it; what the request DID is the reference
 *    model's own conclusion, reached without consulting the plane. If the two
 *    engines disagree about what a request did, that is a finding, and it
 *    cannot be one if the harness lets the plane's answer into the history.
 */
export class DrivenPlane {
  readonly plane: ControlPlane;
  readonly config: ControlPlaneConfig;
  readonly history: RefEvent[] = [];
  /** The reference world, advanced once per event — see `applyEvent`. */
  private readonly world: World = emptyWorld();
  /** What the CALLER believes it holds. Built from admit outcomes only. */
  private readonly held = new Map<string, { slotId: string; token: number }>();

  constructor(config: ControlPlaneConfig) {
    this.config = config;
    this.plane = new ControlPlane(config);
  }

  private record(e: RefEvent): void {
    this.history.push(e);
    applyEvent(this.config, this.world, e);
  }

  admit(vtime: number, tenant: TenantId, runId: string) {
    this.record({ kind: "admit", vtime, tenant, runId });
    const r = this.plane.admit(vtime, tenant, runId);
    if (r.ok) this.held.set(runId, { slotId: r.slotId, token: r.token });
    return r;
  }

  /**
   * Release by runId, using the grant the caller was given.
   *
   * A caller that never received a grant cannot release, so the request is not
   * forwarded and not recorded — it was never issued. That decision is made
   * from the harness's own bookkeeping, never from the plane's state.
   */
  release(vtime: number, runId: string) {
    const h = this.held.get(runId);
    if (h === undefined) return undefined;
    this.record({ kind: "release", vtime, runId });
    return this.plane.release(vtime, h.slotId, h.token);
  }

  complete(vtime: number, runId: string, outcome: "completed" | "failed" = "completed") {
    this.record({ kind: "complete", vtime, runId });
    return this.plane.complete(vtime, runId, outcome);
  }

  cancel(vtime: number, runId: string) {
    this.record({ kind: "cancel", vtime, runId });
    return this.plane.cancel(vtime, runId);
  }

  /**
   * A request from a tenant that does not exist.
   *
   * Refused — but `admit` rolls the window and reclaims expired leases BEFORE
   * it looks the tenant up, so an arriving request drives reclamation whether
   * or not it is granted. That is SEMANTICS C5's "the next claimant" in its
   * weakest form, and it is what lets the quiescence phase drain the pool
   * without adding a fourth operation or a sweeper. `controlPlane.test.ts`
   * pins that ordering so it cannot quietly change.
   */
  probe(vtime: number) {
    return this.plane.admit(vtime, "__probe__", `__probe-${vtime}`);
  }

  state(
    vtime: number,
    over: Partial<
      Pick<CheckableState, "quiesced" | "ticksSinceQuiesce" | "livenessBoundN">
    > = {},
  ): CheckableState {
    const c = this.plane.counters;
    return {
      vtime,
      inFlightByTenant: this.plane.inFlightByTenant(),
      capByTenant: this.plane.capsMap(),
      poolCapacity: this.config.poolCapacity,
      totalClaimed: this.plane.totalClaimed,
      claimsGranted: c.claimsGranted,
      releasesDone: c.releasesDone,
      creditsSpent: this.plane.creditsSpentMap(vtime),
      creditsExpected: creditsInWindow(this.config, this.world, vtime),
      slotOwnerToken: this.plane.slotTokens(),
      acceptedReleases: c.acceptedReleases,
      replayIds: this.plane.log.assignedIds(),
      effectCounts: this.plane.effectCountsMap(),
      quiesced: false,
      ticksSinceQuiesce: 0,
      livenessBoundN: LIVENESS_BOUND_N,
      ...over,
    };
  }
}

/**
 * The calibrated liveness bound N for I6 — SEMANTICS F3.
 *
 * DERIVED, NOT PICKED. `test/quiescence.test.ts` measures the longest drain any
 * seed in the corpus takes after quiescence and asserts this value from both
 * sides: the observed max must be ≤ N (or I6 would fire on a healthy run) AND
 * ≥ 0.5·N (or N is generous enough that I6 cannot fail, which is F3's own
 * `Else` clause and worse than having no invariant). The formula that produces
 * it from the measurement is in that file, so changing the workload moves the
 * bound instead of quietly invalidating it.
 */
export const LIVENESS_BOUND_N = 50;
