import type { Rng } from "../core/rng.js";

/**
 * The substrate that lies.
 *
 * A control plane is only interesting because the thing underneath it is
 * unreliable. If capacity always responds, always tells the truth, and never
 * dies, then admission control is a counter and there is nothing to verify.
 *
 * So this models a capacity provider with every failure mode that makes the
 * problem hard, under seed control:
 *
 *   - responses arrive late
 *   - concurrent responses arrive out of order
 *   - responses arrive twice
 *   - a readiness read reports READY for a pod that is already dead
 *   - a request 5xxs or times out with no response at all
 *   - a pod dies, including between the claim and its first use
 *   - an append is acknowledged and then lost (fsync lied)
 *
 * THE STALE READINESS READ IS THE IMPORTANT ONE. It is why SEMANTICS C3 says no
 * invariant may depend on a readiness poll being truthful: the controller's
 * belief about the world is an opinion, and every guarantee has to survive that
 * opinion being wrong.
 *
 * Faults are weighted toward BOUNDARIES rather than sampled uniformly. A kill at
 * a uniformly random tick almost always lands in the middle of a run, where
 * nothing interesting happens. The bugs live at the transitions — the instant
 * between winning a claim and recording it, between acknowledging an append and
 * durably storing it — so that is where the injector spends its budget.
 */

export type FaultKind =
  | "none"
  | "delay"
  | "reorder"
  | "duplicate"
  | "stale-ready"
  | "error"
  | "timeout"
  | "pod-death"
  | "lost-append";

/** Where in an operation's lifecycle a fault may be injected. */
export type Boundary =
  | "pre-claim"
  | "at-claim"
  | "post-claim-pre-use"
  | "mid-run"
  | "at-complete"
  | "post-complete-pre-ack"
  | "at-release";

export interface FaultSpec {
  readonly kind: FaultKind;
  readonly boundary: Boundary;
  /** For `delay`: how many ticks. */
  readonly delayTicks: number;
}

export interface SubstrateConfig {
  /** Probability that any given operation gets a fault at all. */
  readonly faultRate: number;
  /** Relative weights per fault kind. Order matches FAULT_KINDS. */
  readonly weights: Readonly<Record<Exclude<FaultKind, "none">, number>>;
  readonly maxDelayTicks: number;
}

const FAULT_KINDS: ReadonlyArray<Exclude<FaultKind, "none">> = [
  "delay",
  "reorder",
  "duplicate",
  "stale-ready",
  "error",
  "timeout",
  "pod-death",
  "lost-append",
];

/**
 * Boundaries, ordered by how much trouble a fault there causes.
 *
 * `at-claim` and `post-claim-pre-use` are weighted heavily on purpose: a pod
 * that dies after the claim is recorded but before anyone uses the slot is the
 * canonical orphan, and it is the case a uniform sampler almost never generates.
 */
const BOUNDARY_WEIGHTS: ReadonlyArray<readonly [Boundary, number]> = [
  ["pre-claim", 1],
  ["at-claim", 5],
  ["post-claim-pre-use", 5],
  ["mid-run", 1],
  ["at-complete", 4],
  ["post-complete-pre-ack", 5],
  ["at-release", 3],
];

export const DEFAULT_SUBSTRATE: SubstrateConfig = {
  faultRate: 0.35,
  weights: {
    delay: 3,
    reorder: 2,
    duplicate: 3,
    "stale-ready": 2,
    error: 2,
    timeout: 2,
    "pod-death": 3,
    "lost-append": 2,
  },
  maxDelayTicks: 12,
};

/** A substrate with no faults at all — the baseline arm for calibration. */
export const HONEST_SUBSTRATE: SubstrateConfig = {
  ...DEFAULT_SUBSTRATE,
  faultRate: 0,
};

export class Substrate {
  private readonly rng: Rng;
  private readonly config: SubstrateConfig;
  /** Pods the substrate knows are dead, whatever it reports to a readiness poll. */
  private readonly deadPods = new Set<string>();
  private faultsInjected = 0;

  constructor(rng: Rng, config: SubstrateConfig = DEFAULT_SUBSTRATE) {
    this.rng = rng;
    this.config = config;
  }

  get injectedCount(): number {
    return this.faultsInjected;
  }

  /** Decide whether this operation is faulted, and how. */
  nextFault(): FaultSpec {
    if (!this.rng.nextBool(this.config.faultRate)) {
      return { kind: "none", boundary: "mid-run", delayTicks: 0 };
    }
    const kindIdx = this.rng.weightedIndex(
      FAULT_KINDS.map((k) => this.config.weights[k]),
    );
    const kind = kindIdx < 0 ? "none" : (FAULT_KINDS[kindIdx] as FaultKind);
    const boundaryIdx = this.rng.weightedIndex(BOUNDARY_WEIGHTS.map(([, w]) => w));
    const boundary =
      boundaryIdx < 0
        ? "mid-run"
        : ((BOUNDARY_WEIGHTS[boundaryIdx] as readonly [Boundary, number])[0] as Boundary);
    const delayTicks =
      kind === "delay" ? this.rng.nextInt(1, this.config.maxDelayTicks + 1) : 0;
    if (kind !== "none") this.faultsInjected++;
    return { kind, boundary, delayTicks };
  }

  /** Mark a pod dead. Readiness reads may still lie about it — that is the point. */
  killPod(podId: string): void {
    this.deadPods.add(podId);
  }

  isActuallyDead(podId: string): boolean {
    return this.deadPods.has(podId);
  }

  /**
   * What a readiness poll REPORTS, which is not necessarily the truth.
   *
   * A dead pod is reported ready with probability `staleRate` — the controller
   * has no way to tell. Every invariant must hold anyway (SEMANTICS C3).
   */
  reportsReady(podId: string, staleRate: number): boolean {
    if (!this.deadPods.has(podId)) return true;
    return this.rng.nextBool(staleRate);
  }
}
