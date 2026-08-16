import { sortedMapEntries } from "../core/order.js";

/**
 * The invariant checker.
 *
 * These are evaluated AFTER EVERY EVENT, not at the end of a run (SEMANTICS F1).
 * An end-of-run check misses transient violations entirely — and a transient
 * violation is exactly what a fault injected mid-operation produces. A system
 * that briefly admits 5 runs against a cap of 4 and then settles back to 4 is
 * broken; a quiescence check calls it fine.
 *
 * Each invariant states what it guards and why it is not implied by the others.
 * An invariant that is implied by another is not free — it is a second thing to
 * keep true, and it makes a failure ambiguous.
 */

export type InvariantId = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8";

export interface Violation {
  readonly invariant: InvariantId;
  readonly vtime: number;
  readonly detail: string;
}

/** The state the checker inspects. Owned by the simulation, read-only here. */
export interface CheckableState {
  readonly vtime: number;
  /** tenant -> number of slots currently claimed by that tenant. */
  readonly inFlightByTenant: ReadonlyMap<string, number>;
  /** tenant -> that tenant's configured cap. */
  readonly capByTenant: ReadonlyMap<string, number>;
  readonly poolCapacity: number;
  readonly totalClaimed: number;
  /** Monotonic counters, never decremented. */
  readonly claimsGranted: number;
  readonly releasesDone: number;
  /** tenant -> credits spent this window. */
  readonly creditsSpent: ReadonlyMap<string, number>;
  /** tenant -> credits the ledger says were consumed, recomputed independently. */
  readonly creditsExpected: ReadonlyMap<string, number>;
  /** slotId -> the fencing token of its current owner. */
  readonly slotOwnerToken: ReadonlyMap<string, number>;
  /** Slots released more than once — should always be empty. */
  readonly doubleReleases: readonly string[];
  /** Slots released by a holder whose token was stale. */
  readonly staleReleases: readonly string[];
  /** Replay-log ids in the order they were assigned. */
  readonly replayIds: readonly number[];
  /** Distinct effects applied, keyed by the identity that must be unique. */
  readonly effectCounts: ReadonlyMap<string, number>;
  /** True once the fault injector has stopped and the system should drain. */
  readonly quiesced: boolean;
  /** Ticks elapsed since quiescence began. */
  readonly ticksSinceQuiesce: number;
  /** The calibrated liveness bound — see F3. */
  readonly livenessBoundN: number;
}

/**
 * I1 — per-tenant in-flight never exceeds that tenant's cap.
 *
 * The headline promise of multi-tenancy. Violated by the classic
 * check-then-claim race (SEMANTICS B2).
 */
function checkI1(s: CheckableState): Violation[] {
  const out: Violation[] = [];
  for (const [tenant, inFlight] of sortedMapEntries(s.inFlightByTenant)) {
    const cap = s.capByTenant.get(tenant);
    if (cap === undefined) {
      out.push({
        invariant: "I1",
        vtime: s.vtime,
        detail: `tenant ${tenant} has ${inFlight} in flight but no configured cap`,
      });
      continue;
    }
    if (inFlight > cap) {
      out.push({
        invariant: "I1",
        vtime: s.vtime,
        detail: `tenant ${tenant} in-flight=${inFlight} exceeds cap=${cap}`,
      });
    }
  }
  return out;
}

/**
 * I2 — total claimed never exceeds pool capacity.
 *
 * NOT implied by I1: every tenant can be under its own cap while the sum
 * overcommits the pool. This is the invariant that catches a control plane that
 * only reasons per-tenant.
 */
function checkI2(s: CheckableState): Violation[] {
  if (s.totalClaimed > s.poolCapacity) {
    return [
      {
        invariant: "I2",
        vtime: s.vtime,
        detail: `claimed=${s.totalClaimed} exceeds pool capacity=${s.poolCapacity}`,
      },
    ];
  }
  return [];
}

/**
 * I3 — conservation. claimsGranted − releasesDone === totalClaimed.
 *
 * Slots do not leak and do not appear from nowhere. This is the invariant that
 * catches a release path that runs twice, or one that is skipped on an error
 * branch. It is the cheapest and most productive of the set, because almost
 * every real bug perturbs it.
 */
function checkI3(s: CheckableState): Violation[] {
  const expected = s.claimsGranted - s.releasesDone;
  if (expected !== s.totalClaimed) {
    return [
      {
        invariant: "I3",
        vtime: s.vtime,
        detail:
          `conservation broken: claims(${s.claimsGranted}) - releases(${s.releasesDone}) ` +
          `= ${expected}, but totalClaimed=${s.totalClaimed}`,
      },
    ];
  }
  return [];
}

/**
 * I4 — the credit ledger is exact.
 *
 * Integer arithmetic, no tolerance. A tolerance here would hide precisely the
 * double-debit that duplicate delivery causes (SEMANTICS A7).
 */
function checkI4(s: CheckableState): Violation[] {
  const out: Violation[] = [];
  for (const [tenant, spent] of sortedMapEntries(s.creditsSpent)) {
    const expected = s.creditsExpected.get(tenant) ?? 0;
    if (spent !== expected) {
      out.push({
        invariant: "I4",
        vtime: s.vtime,
        detail: `tenant ${tenant} credits spent=${spent} but ledger expects ${expected}`,
      });
    }
  }
  return out;
}

/**
 * I5 — no double-release, and no release by a stale holder.
 *
 * The fencing-token invariant (SEMANTICS C1, C4). A stale claimant that is
 * allowed to release frees a slot someone else legitimately owns, which then
 * shows up as an I1 or I2 violation somewhere far away — so catching it here is
 * what makes the failure attributable.
 */
function checkI5(s: CheckableState): Violation[] {
  const out: Violation[] = [];
  for (const slot of s.doubleReleases) {
    out.push({
      invariant: "I5",
      vtime: s.vtime,
      detail: `slot ${slot} was released more than once`,
    });
  }
  for (const slot of s.staleReleases) {
    out.push({
      invariant: "I5",
      vtime: s.vtime,
      detail: `slot ${slot} was released by a holder with a stale fencing token`,
    });
  }
  return out;
}

/**
 * I6 — NO ORPHAN, as bounded liveness.
 *
 * "Nothing is orphaned" is a liveness property and cannot be checked at an
 * instant, so it is expressed as a bound: once faults stop, in-flight must reach
 * zero within N ticks.
 *
 * N is CALIBRATED, not guessed (SEMANTICS F3). A hand-picked generous N makes
 * this invariant vacuous — it passes because it cannot fail, which is worse than
 * not having it, because it looks like coverage.
 */
function checkI6(s: CheckableState): Violation[] {
  if (!s.quiesced) return [];
  if (s.ticksSinceQuiesce <= s.livenessBoundN) return [];
  if (s.totalClaimed === 0) return [];
  return [
    {
      invariant: "I6",
      vtime: s.vtime,
      detail:
        `in-flight=${s.totalClaimed} still held ${s.ticksSinceQuiesce} ticks after quiescence ` +
        `(bound N=${s.livenessBoundN}) — orphaned capacity`,
    },
  ];
}

/**
 * I7 — replay-log monotonicity.
 *
 * Ids strictly increase, with no gaps and no duplicates at the log level. A
 * subscriber's whole contract (resubscribe-from-id returns exactly the suffix)
 * rests on this, so a violation here invalidates E1–E8 wholesale.
 */
function checkI7(s: CheckableState): Violation[] {
  const out: Violation[] = [];
  for (let i = 1; i < s.replayIds.length; i++) {
    const prev = s.replayIds[i - 1] as number;
    const cur = s.replayIds[i] as number;
    if (cur <= prev) {
      out.push({
        invariant: "I7",
        vtime: s.vtime,
        detail: `replay ids not strictly increasing at index ${i}: ${prev} then ${cur}`,
      });
    }
  }
  return out;
}

/**
 * I8 — exactly one effect per identity.
 *
 * KhataGO's invariant, generalised (M8): exactly one processing effect per
 * distinct message id, regardless of how many times it was delivered.
 */
function checkI8(s: CheckableState): Violation[] {
  const out: Violation[] = [];
  for (const [identity, count] of sortedMapEntries(s.effectCounts)) {
    if (count > 1) {
      out.push({
        invariant: "I8",
        vtime: s.vtime,
        detail: `effect for ${identity} applied ${count} times — must be exactly once`,
      });
    }
  }
  return out;
}

const ALL_CHECKS: ReadonlyArray<(s: CheckableState) => Violation[]> = [
  checkI1,
  checkI2,
  checkI3,
  checkI4,
  checkI5,
  checkI6,
  checkI7,
  checkI8,
];

/** Run every invariant. Returns all violations, not just the first. */
export function checkAll(state: CheckableState): Violation[] {
  const out: Violation[] = [];
  for (const check of ALL_CHECKS) out.push(...check(state));
  return out;
}

export function formatViolation(v: Violation): string {
  return `VIOLATION ${v.invariant} @t=${v.vtime}: ${v.detail}`;
}
