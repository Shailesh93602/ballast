import {
  REJECTION_PRECEDENCE,
  type ControlPlaneConfig,
  type RejectReason,
  type TenantId,
} from "../policy/types.js";

/**
 * The reference scheduler. Deliberately stupid.
 *
 * For every decision it recomputes the answer from the ENTIRE event history,
 * holding zero incremental state. O(n²) over a run, and proud of it.
 *
 * WHY SLOW ON PURPOSE: the implementation is fast because it maintains
 * incremental state — counters, maps, a slot array. Incremental state is exactly
 * where the bugs live: a counter not decremented on an error path, a map entry
 * not cleared on cancel, a release that runs twice. A reference that keeps the
 * same incremental state would make the same mistakes and the differential would
 * agree with itself. Recomputing from scratch every time shares no machinery
 * with the thing it is checking, which is the only reason its agreement means
 * anything.
 *
 * WHAT THIS ORACLE CANNOT DO — stated here rather than discovered in an
 * interview: the reference and the implementation share one author and one
 * specification. This validates implementation-against-intent. It cannot
 * validate intent-against-reality. If docs/SEMANTICS.md is wrong, both halves
 * are wrong together and this test passes. That is precisely why I1–I8 exist
 * independently of it, why several planted mutants in M5 live in the
 * shared-spec blind class, and why SEMANTICS.md was ratified before any of this
 * was written.
 *
 * ONE PART OF THAT BLINDNESS IS NOW CLOSED, AND IT IS WORTH BEING PRECISE ABOUT
 * WHICH. This file used to short-circuit its refusal checks in a hardcoded
 * order, and so did the implementation, and the order was written in neither
 * SEMANTICS.md nor anywhere else. The differential compared the reason, which
 * made the question look answered while both halves were reading the same
 * unwritten decision. It now evaluates EVERY condition (`refusalConditions`)
 * and resolves the set through `REJECTION_PRECEDENCE`, which
 * `test/precedence.test.ts` checks against the order declared in SEMANTICS B7.
 * The two engines still share a specification — they can no longer share it
 * silently.
 */

export type RefEvent =
  | {
      readonly kind: "admit";
      readonly vtime: number;
      readonly tenant: TenantId;
      readonly runId: string;
    }
  | { readonly kind: "release"; readonly vtime: number; readonly runId: string }
  | { readonly kind: "complete"; readonly vtime: number; readonly runId: string }
  | { readonly kind: "cancel"; readonly vtime: number; readonly runId: string };

export type RefDecision =
  | { readonly kind: "admitted"; readonly runId: string }
  | { readonly kind: "rejected"; readonly runId: string; readonly reason: RejectReason }
  | { readonly kind: "released"; readonly runId: string }
  | { readonly kind: "completed"; readonly runId: string; readonly duplicate: boolean }
  | { readonly kind: "cancelled"; readonly runId: string }
  | { readonly kind: "noop"; readonly runId: string };

type RunStatus = "held" | "released" | "completed" | "cancelled";

/** One accepted claim. Credit is debited per CLAIM (A3), not per identity. */
interface Claim {
  readonly runId: string;
  readonly tenant: TenantId;
  readonly window: number;
}

/**
 * The world as of the events strictly before `index`, rebuilt from scratch.
 *
 * `claims` is a LIST, not a map keyed by runId. One identity can hold more than
 * one claim over its lifetime — a run that was released, or whose lease expired
 * and whose slot was reclaimed, is not live, so a later admit of the same id is
 * a fresh claim that takes a slot and spends a credit (SEMANTICS A10). Keyed by
 * runId, the second claim was invisible: the map entry was simply overwritten,
 * so the ledger said one credit where the plane had spent two.
 */
export interface World {
  readonly status: Map<string, RunStatus>;
  readonly tenantOf: Map<string, TenantId>;
  readonly claimedAt: Map<string, number>;
  readonly claims: Claim[];
}

export function emptyWorld(): World {
  return {
    status: new Map(),
    tenantOf: new Map(),
    claimedAt: new Map(),
    claims: [],
  };
}

const windowOf = (t: number, config: ControlPlaneConfig): number =>
  Math.floor(t / config.windowTicks);

/**
 * Is this run's claim still LIVE at `now`?
 *
 * Held, and its lease has not expired. An expired claim is not live even though
 * nothing has swept it yet: the implementation reclaims lazily (C5) but does so
 * at the TOP of `admit`, so by the time the duplicate check runs the expired
 * slot is already free. The two notions of "live" have to agree or the
 * differential reports a divergence that is really a definition mismatch.
 */
function isLive(world: World, runId: string, now: number, config: ControlPlaneConfig) {
  if (world.status.get(runId) !== "held") return false;
  const at = world.claimedAt.get(runId);
  if (at === undefined) return false;
  return at + config.leaseTicks > now;
}

/**
 * THE TRANSITION FUNCTION — the only place the reference model advances.
 *
 * `replayPrior` restarts from nothing and applies this once per prior event, so
 * `referenceDecision` keeps the from-scratch, zero-incremental-state property
 * the whole oracle argument rests on. The invariant corpus cannot afford that:
 * recomputing from scratch after every one of 120 events, across 2,000 seeds,
 * with an O(world) predicate inside, is cubic and takes the suite from four
 * seconds to minutes.
 *
 * So the corpus STREAMS: it keeps one world and calls this once per event. That
 * is incremental state, which is exactly what the reference exists not to have —
 * and the mitigation is not a promise, it is
 * `test/precedence.test.ts` → "the streaming ledger and the from-scratch replay
 * agree event for event", which runs both over the same histories. The
 * transition is written ONCE, so the two cannot disagree about the rules; the
 * test is there to catch the two disagreeing about the STATE.
 */
export function applyEvent(config: ControlPlaneConfig, world: World, e: RefEvent): void {
  switch (e.kind) {
    case "admit": {
      // A duplicate of a LIVE claim changes nothing: same slot, same credit.
      if (isLive(world, e.runId, e.vtime, config)) break;
      if (refusalConditions(config, world, e.tenant, e.runId, e.vtime).length > 0) {
        break;
      }
      world.status.set(e.runId, "held");
      world.tenantOf.set(e.runId, e.tenant);
      world.claimedAt.set(e.runId, e.vtime);
      world.claims.push({
        runId: e.runId,
        tenant: e.tenant,
        window: windowOf(e.vtime, config),
      });
      break;
    }
    case "release":
      if (world.status.get(e.runId) === "held") world.status.set(e.runId, "released");
      break;
    case "complete":
      // SEMANTICS B6 — completion is terminal and frees the slot.
      if (world.status.get(e.runId) === "held") world.status.set(e.runId, "completed");
      break;
    case "cancel":
      if (world.status.get(e.runId) !== "completed")
        world.status.set(e.runId, "cancelled");
      break;
  }
}

function replayPrior(
  config: ControlPlaneConfig,
  history: readonly RefEvent[],
  index: number,
): World {
  const world = emptyWorld();
  for (let i = 0; i < index; i++) applyEvent(config, world, history[i] as RefEvent);
  return world;
}

/**
 * EVERY refusal condition that holds for this request — not the first one.
 *
 * No short-circuiting anywhere in here. The whole point is that the SET is
 * computed independently of the ORDER: this function answers "what is wrong
 * with this request", and `REJECTION_PRECEDENCE` answers "which of those the
 * caller is told about". Fusing the two is what let the order go unwritten.
 *
 * A tenant with no configured cap yields exactly `unknown-tenant` for the
 * capacity conditions: there is no cap to compare against and no budget to
 * spend, so `cap-exceeded` and `no-credit` are not merely false, they are not
 * evaluable. The lifecycle conditions still apply — an unknown tenant can
 * perfectly well name a runId that was already cancelled, and that overlap is
 * the one the two engines silently disagreed about (LEDGER L23).
 */
function refusalConditions(
  config: ControlPlaneConfig,
  world: World,
  tenant: TenantId,
  runId: string,
  now: number,
): RejectReason[] {
  const out: RejectReason[] = [];
  const status = world.status.get(runId);

  const cfg = config.tenants.find((t) => t.id === tenant);
  if (cfg === undefined) out.push("unknown-tenant");
  if (status === "cancelled") out.push("cancelled-before-start");
  if (status === "completed") out.push("run-already-terminal");

  if (cfg !== undefined) {
    let heldByTenant = 0;
    for (const [id, st] of world.status) {
      if (st !== "held") continue;
      if (world.tenantOf.get(id) !== tenant) continue;
      if ((world.claimedAt.get(id) ?? 0) + config.leaseTicks <= now) continue;
      heldByTenant++;
    }
    if (heldByTenant >= cfg.cap) out.push("cap-exceeded");

    const window = windowOf(now, config);
    let spent = 0;
    for (const c of world.claims) {
      if (c.window === window && c.tenant === tenant) spent++;
    }
    if (spent >= cfg.creditsPerWindow) out.push("no-credit");
  }

  let allHeld = 0;
  for (const [id, st] of world.status) {
    if (st !== "held") continue;
    if ((world.claimedAt.get(id) ?? 0) + config.leaseTicks <= now) continue;
    allHeld++;
  }
  if (allHeld >= config.poolCapacity) out.push("pool-full");

  return out;
}

/** Resolve a set of simultaneous refusals to the one reported — SEMANTICS B7. */
export function resolveByPrecedence(reasons: readonly RejectReason[]): RejectReason {
  for (const candidate of REJECTION_PRECEDENCE) {
    if (reasons.includes(candidate)) return candidate;
  }
  throw new Error(
    `resolveByPrecedence: no declared precedence for [${reasons.join(", ")}] — ` +
      `every RejectReason must appear in REJECTION_PRECEDENCE (SEMANTICS B7)`,
  );
}

/**
 * Every refusal condition holding for the admit at `index`, recomputed from
 * history. Empty means the request would be accepted.
 *
 * Exported so `test/precedence.test.ts` can census the corpus for events where
 * TWO OR MORE hold at once — the states in which precedence is observable at
 * all. A precedence test run over a corpus that never produces an overlap is
 * the same vacuity as L13.
 */
export function referenceRefusals(
  config: ControlPlaneConfig,
  history: readonly RefEvent[],
  index: number,
): RejectReason[] {
  const ev = history[index];
  if (ev === undefined || ev.kind !== "admit") return [];
  const world = replayPrior(config, history, index);
  if (isLive(world, ev.runId, ev.vtime, config)) return [];
  return refusalConditions(config, world, ev.tenant, ev.runId, ev.vtime);
}

/**
 * The credit ledger, rebuilt from the event history — I4's expected side.
 *
 * THIS IS THE ORACLE `ControlPlane.creditsExpected()` WAS NOT. That method was a
 * method on the class it checked, walking `this.runs` — the very map `admit`
 * writes. Two views of one piece of state can only ever disagree about their own
 * consistency; they cannot disagree about whether the state matches the history
 * that produced it. So the whole class of bug where the plane and its own
 * bookkeeping are wrong TOGETHER was outside I4's reach by construction, and it
 * is not a hypothetical class: it is exactly what the re-admit bugs (L22) did —
 * a claim the plane granted and never billed, invisible because the unbilled
 * claim was missing from both sides at once.
 *
 * `window` is derived from the event's own virtual time rather than from any
 * counter the plane keeps, so a plane whose window pointer is wrong is
 * measurable instead of self-consistent.
 */
export function creditsInWindow(
  config: ControlPlaneConfig,
  world: World,
  now: number,
): ReadonlyMap<TenantId, number> {
  const window = windowOf(now, config);
  const out = new Map<TenantId, number>();
  for (const t of config.tenants) out.set(t.id, 0);
  for (const c of world.claims) {
    if (c.window !== window) continue;
    out.set(c.tenant, (out.get(c.tenant) ?? 0) + 1);
  }
  return out;
}

/** The same ledger, rebuilt from scratch out of the raw history. */
export function referenceCreditsSpent(
  config: ControlPlaneConfig,
  history: readonly RefEvent[],
  uptoIndexInclusive: number,
  now: number,
): ReadonlyMap<TenantId, number> {
  return creditsInWindow(
    config,
    replayPrior(config, history, uptoIndexInclusive + 1),
    now,
  );
}

/**
 * Replay the whole history from the beginning and answer: what happens at
 * `index`? Called once per event, so the whole run is quadratic.
 */
export function referenceDecision(
  config: ControlPlaneConfig,
  history: readonly RefEvent[],
  index: number,
): RefDecision {
  const ev = history[index];
  if (ev === undefined) throw new Error(`referenceDecision: no event at ${index}`);

  const world = replayPrior(config, history, index);

  switch (ev.kind) {
    case "admit": {
      // A duplicate of a LIVE claim is ACKED with the grant already issued
      // (A9). A claim that has been released or has expired is NOT live, so
      // this is a fresh claim rather than an echo (A10).
      if (isLive(world, ev.runId, ev.vtime, config)) {
        return { kind: "admitted", runId: ev.runId };
      }
      const reasons = refusalConditions(config, world, ev.tenant, ev.runId, ev.vtime);
      if (reasons.length === 0) return { kind: "admitted", runId: ev.runId };
      return {
        kind: "rejected",
        runId: ev.runId,
        reason: resolveByPrecedence(reasons),
      };
    }
    case "release":
      return world.status.get(ev.runId) === "held"
        ? { kind: "released", runId: ev.runId }
        : { kind: "noop", runId: ev.runId };
    case "complete": {
      const st = world.status.get(ev.runId);
      if (st === "completed")
        return { kind: "completed", runId: ev.runId, duplicate: true };
      if (st === "held") return { kind: "completed", runId: ev.runId, duplicate: false };
      return { kind: "noop", runId: ev.runId };
    }
    case "cancel": {
      const st = world.status.get(ev.runId);
      if (st === "completed") return { kind: "noop", runId: ev.runId };
      if (st === "cancelled") return { kind: "noop", runId: ev.runId };
      return { kind: "cancelled", runId: ev.runId };
    }
  }
}
