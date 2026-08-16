import { Clock } from "./clock.js";
import { DecisionLog } from "./decisionLog.js";
import { Rng } from "./rng.js";
import { byKey } from "./order.js";

/**
 * The simulation driver.
 *
 * M0 scope: this exists to prove the spine is deterministic. It runs a
 * deliberately trivial workload through a deliberately trivial policy so that
 * `hashDecisionLog` has something non-empty to be identical about. The real
 * control plane lands in M3 behind the same `Policy` interface, and the
 * determinism guard written against this skeleton keeps holding for it.
 *
 * Everything nondeterministic is threaded, never ambient: the Rng is passed in,
 * time comes from the Clock, and iteration goes through core/order.
 */

export interface SimEvent {
  readonly kind: "arrive" | "finish";
  readonly tenant: string;
  readonly runId: string;
}

export interface Policy {
  readonly name: string;
  /**
   * Decide whether a run may start. Implementations must be pure with respect
   * to their arguments plus their own declared state — no clocks, no randomness
   * that was not threaded in.
   */
  onArrive(ctx: PolicyContext, ev: SimEvent): void;
  onFinish(ctx: PolicyContext, ev: SimEvent): void;
}

export interface PolicyContext {
  readonly now: number;
  readonly log: DecisionLog;
  readonly rng: Rng;
  /** Schedule a future event. Delay is in virtual ticks. */
  scheduleIn(delay: number, ev: SimEvent): void;
}

export interface SimConfig {
  readonly seed: number;
  readonly tenants: readonly string[];
  /** How many runs each tenant submits. */
  readonly runsPerTenant: number;
  /** Upper bound on arrival jitter, in ticks. */
  readonly maxArrivalJitter: number;
  /** Upper bound on how long a run takes, in ticks. */
  readonly maxDuration: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 1,
  tenants: ["acme", "globex", "initech"],
  runsPerTenant: 8,
  maxArrivalJitter: 40,
  maxDuration: 25,
};

/**
 * A placeholder policy: admits everything, up to a fixed global cap.
 *
 * It is NOT the control plane and makes no correctness claim — it exists so the
 * spine has a decision stream to hash. M3 replaces it.
 */
export class NaivePolicy implements Policy {
  readonly name = "naive";
  private inFlight = 0;
  // NOTE: a plain field, not a TypeScript parameter property. Parameter
  // properties cannot be erased by type-stripping, and the determinism guard
  // runs this module in a fresh `node --experimental-strip-types` process.
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  onArrive(ctx: PolicyContext, ev: SimEvent): void {
    if (this.inFlight >= this.capacity) {
      ctx.log.append({
        vtime: ctx.now,
        kind: "reject",
        tenant: ev.tenant,
        runId: ev.runId,
        decision: "rejected",
        reason: `pool-full(${this.inFlight}/${this.capacity})`,
      });
      return;
    }
    this.inFlight++;
    ctx.log.append({
      vtime: ctx.now,
      kind: "admit",
      tenant: ev.tenant,
      runId: ev.runId,
      decision: "admitted",
      reason: `in-flight=${this.inFlight}`,
    });
    const duration = ctx.rng.nextInt(1, 26);
    ctx.scheduleIn(duration, { kind: "finish", tenant: ev.tenant, runId: ev.runId });
  }

  onFinish(ctx: PolicyContext, ev: SimEvent): void {
    this.inFlight--;
    ctx.log.append({
      vtime: ctx.now,
      kind: "release",
      tenant: ev.tenant,
      runId: ev.runId,
      decision: "released",
      reason: `in-flight=${this.inFlight}`,
    });
  }
}

export interface SimResult {
  readonly log: DecisionLog;
  readonly finalTime: number;
  readonly eventsProcessed: number;
}

export function runSimulation(
  config: SimConfig = DEFAULT_CONFIG,
  policy: Policy = new NaivePolicy(4),
): SimResult {
  const clock = new Clock<SimEvent>();
  const log = new DecisionLog();
  const rng = new Rng(config.seed);
  const arrivalRng = rng.fork("arrivals");
  const policyRng = rng.fork("policy");

  // Seed the arrival schedule. Tenants are sorted so the construction order of
  // the config cannot leak into the event stream.
  const tenants = byKey(config.tenants, (t) => t);
  for (const tenant of tenants) {
    for (let i = 0; i < config.runsPerTenant; i++) {
      const jitter = arrivalRng.nextInt(0, config.maxArrivalJitter + 1);
      clock.scheduleAt(jitter, {
        kind: "arrive",
        tenant,
        runId: `${tenant}-${i}`,
      });
    }
  }

  const ctx: PolicyContext = {
    get now() {
      return clock.now();
    },
    log,
    rng: policyRng,
    scheduleIn: (delay, ev) => clock.scheduleIn(delay, ev),
  };

  let processed = 0;
  for (;;) {
    const ev = clock.advance();
    if (ev === undefined) break;
    processed++;
    if (ev.payload.kind === "arrive") policy.onArrive(ctx, ev.payload);
    else policy.onFinish(ctx, ev.payload);
  }

  return { log, finalTime: clock.now(), eventsProcessed: processed };
}
