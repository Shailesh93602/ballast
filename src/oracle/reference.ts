import type { ControlPlaneConfig, RejectReason, TenantId } from "../policy/types.js";

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
 * are wrong together and this test passes. That is precisely why I1–I7 exist
 * independently of it, why several planted mutants in M5 live in the
 * shared-spec blind class, and why SEMANTICS.md was ratified before any of this
 * was written.
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

  // Rebuild the world from scratch, using only events strictly before `index`.
  const prior = history.slice(0, index);

  const capOf = new Map<TenantId, number>();
  const budgetOf = new Map<TenantId, number>();
  for (const t of config.tenants) {
    capOf.set(t.id, t.cap);
    budgetOf.set(t.id, t.creditsPerWindow);
  }

  /** runId -> its terminal or current status, derived by replay. */
  const status = new Map<string, "held" | "released" | "completed" | "cancelled">();
  const tenantOf = new Map<string, TenantId>();
  const claimedAt = new Map<string, number>();
  /**
   * runId -> the window in which its credit was actually spent, for the runs
   * whose admit was ACCEPTED. This is the credit ledger, recomputed.
   *
   * TWO CORRECTIONS ARE ENCODED HERE, both found by the differential.
   *
   * It is deliberately NOT keyed off `status.has(runId)`. A cancel inserts a
   * runId into `status` even for a run whose admit was rejected, so keying
   * credit off the status map billed rejected-then-cancelled runs for credit
   * they never spent (L3).
   *
   * And it is keyed by RUN, not by admit EVENT. Delivery is at-least-once, so
   * the same admit can arrive twice; walking the event list billed a retry a
   * second time (SEMANTICS A9, L21). No corpus generated a duplicate runId, so
   * the two definitions were indistinguishable until the fault injector was
   * wired to the control plane.
   *
   * An earlier version kept a separate accepted-claims Set alongside this map.
   * Once `countSpent` stopped walking the events, nothing read it — dead state
   * of exactly the shape L5 recorded, so it is gone rather than left looking
   * load-bearing.
   */
  const claimWindowOf = new Map<string, number>();
  const tenantClaimed = new Map<string, TenantId>();

  const windowOf = (t: number): number => Math.floor(t / config.windowTicks);

  for (const e of prior) {
    switch (e.kind) {
      case "admit": {
        // Was this admit accepted? Recompute the same predicate the same way.
        if (status.get(e.runId) === "cancelled") break;
        if (status.get(e.runId) === "completed") break; // A9 — single-use id
        // A duplicate of a live claim changes nothing: same slot, same credit.
        if (status.get(e.runId) === "held") break;
        const held = countHeld(status, tenantOf, claimedAt, e.tenant, e.vtime, config);
        const cap = capOf.get(e.tenant);
        if (cap === undefined) break;
        if (held >= cap) break;
        const spent = countSpent(
          claimWindowOf,
          tenantClaimed,
          e.tenant,
          windowOf(e.vtime),
        );
        if (spent >= (budgetOf.get(e.tenant) ?? 0)) break;
        if (countAllHeld(status, claimedAt, e.vtime, config) >= config.poolCapacity)
          break;
        status.set(e.runId, "held");
        tenantOf.set(e.runId, e.tenant);
        tenantClaimed.set(e.runId, e.tenant);
        claimWindowOf.set(e.runId, windowOf(e.vtime));
        claimedAt.set(e.runId, e.vtime);
        break;
      }
      case "release":
        if (status.get(e.runId) === "held") status.set(e.runId, "released");
        break;
      case "complete":
        // SEMANTICS B6 — completion is terminal and frees the slot.
        if (status.get(e.runId) === "held") status.set(e.runId, "completed");
        break;
      case "cancel":
        if (status.get(e.runId) !== "completed") status.set(e.runId, "cancelled");
        break;
    }
  }

  // Now decide the event at `index`.
  switch (ev.kind) {
    case "admit": {
      if (status.get(ev.runId) === "cancelled") {
        return { kind: "rejected", runId: ev.runId, reason: "cancelled-before-start" };
      }
      if (status.get(ev.runId) === "completed") {
        // SEMANTICS A9 — an identity is single-use.
        return { kind: "rejected", runId: ev.runId, reason: "run-already-terminal" };
      }
      if (status.get(ev.runId) === "held") {
        // A duplicate of a live claim is ACKED with the grant already issued.
        return { kind: "admitted", runId: ev.runId };
      }
      const cap = capOf.get(ev.tenant);
      if (cap === undefined) {
        return { kind: "rejected", runId: ev.runId, reason: "unknown-tenant" };
      }
      const held = countHeld(status, tenantOf, claimedAt, ev.tenant, ev.vtime, config);
      if (held >= cap) {
        return { kind: "rejected", runId: ev.runId, reason: "cap-exceeded" };
      }
      const spent = countSpent(
        claimWindowOf,
        tenantClaimed,
        ev.tenant,
        windowOf(ev.vtime),
      );
      if (spent >= (budgetOf.get(ev.tenant) ?? 0)) {
        return { kind: "rejected", runId: ev.runId, reason: "no-credit" };
      }
      if (countAllHeld(status, claimedAt, ev.vtime, config) >= config.poolCapacity) {
        return { kind: "rejected", runId: ev.runId, reason: "pool-full" };
      }
      return { kind: "admitted", runId: ev.runId };
    }
    case "release":
      return status.get(ev.runId) === "held"
        ? { kind: "released", runId: ev.runId }
        : { kind: "noop", runId: ev.runId };
    case "complete": {
      const st = status.get(ev.runId);
      if (st === "completed")
        return { kind: "completed", runId: ev.runId, duplicate: true };
      if (st === "held") return { kind: "completed", runId: ev.runId, duplicate: false };
      return { kind: "noop", runId: ev.runId };
    }
    case "cancel": {
      const st = status.get(ev.runId);
      if (st === "completed") return { kind: "noop", runId: ev.runId };
      if (st === "cancelled") return { kind: "noop", runId: ev.runId };
      return { kind: "cancelled", runId: ev.runId };
    }
  }
}

/** How many slots this tenant holds right now, counting lease expiry. */
function countHeld(
  status: ReadonlyMap<string, string>,
  tenantOf: ReadonlyMap<string, TenantId>,
  claimedAt: ReadonlyMap<string, number>,
  tenant: TenantId,
  now: number,
  config: ControlPlaneConfig,
): number {
  let n = 0;
  for (const [runId, st] of status) {
    if (st !== "held") continue;
    if (tenantOf.get(runId) !== tenant) continue;
    const at = claimedAt.get(runId) ?? 0;
    if (at + config.leaseTicks <= now) continue; // lease expired, reclaimed
    n++;
  }
  return n;
}

function countAllHeld(
  status: ReadonlyMap<string, string>,
  claimedAt: ReadonlyMap<string, number>,
  now: number,
  config: ControlPlaneConfig,
): number {
  let n = 0;
  for (const [runId, st] of status) {
    if (st !== "held") continue;
    const at = claimedAt.get(runId) ?? 0;
    if (at + config.leaseTicks <= now) continue;
    n++;
  }
  return n;
}

/**
 * Credits this tenant has spent in the given window, recomputed from history.
 *
 * Counted per RUN that actually took a slot, because credit is debited at claim
 * (SEMANTICS A3) — an admit that was rejected never spent anything, and a
 * duplicate admit of a live claim never spent anything either (A9).
 *
 * This used to walk the admit EVENTS, which billed an at-least-once retry a
 * second time. No corpus generated a duplicate runId, so the two definitions
 * were indistinguishable until the fault injector was wired to the control
 * plane.
 */
function countSpent(
  claimWindowOf: ReadonlyMap<string, number>,
  tenantClaimed: ReadonlyMap<string, TenantId>,
  tenant: TenantId,
  window: number,
): number {
  let n = 0;
  for (const [runId, w] of claimWindowOf) {
    if (w !== window) continue;
    if (tenantClaimed.get(runId) !== tenant) continue;
    n++;
  }
  return n;
}
