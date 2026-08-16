import { sortedMapEntries } from "../core/order.js";
import type { AcceptedRelease } from "../oracle/invariants.js";
import { ReplayLog } from "./replayLog.js";
import {
  type AdmitOutcome,
  type CompleteOutcome,
  type ControlPlaneConfig,
  type FencingToken,
  type ReleaseOutcome,
  type RunId,
  type SlotId,
  type TenantId,
} from "./types.js";

/**
 * The control plane.
 *
 * Three operations — admit, release, complete — over per-tenant caps, a tumbling
 * credit window, a finite pool, leases with fencing tokens, and a durable
 * completion log.
 *
 * Every decision here traces to a numbered row in docs/SEMANTICS.md. Where the
 * code looks arbitrary, the row says why; where the row was genuinely open, it
 * is marked TBD there rather than silently resolved here. That is the whole
 * point of the document existing before this file did.
 */

interface Slot {
  readonly id: SlotId;
  tenant: TenantId | null;
  token: FencingToken;
  leaseUntil: number;
  /**
   * NOTE: there is deliberately no `runId` or `released` flag here.
   *
   * `released` was assigned `false` in four places and `true` in none, so the
   * `if (slot.released)` branch that guarded double-release was UNREACHABLE —
   * a second release fell through to the `tenant === null` check and answered
   * `not-held` instead of `already-released`. Refused either way, but with a
   * misleading reason and a field that looked load-bearing while doing nothing.
   * Mechanical mutation found it: deleting each assignment changed no
   * observable behaviour, which is the signature of dead state.
   *
   * There is no `runId` either. It was assigned in five places and read in
   * none — run identity lives on `RunState` and in the decision log, which is
   * where anything actually looks for it.
   */
}

interface RunState {
  readonly runId: RunId;
  readonly tenant: TenantId;
  slotId: SlotId | null;
  status: "admitted" | "completed" | "cancelled";
  /** Set once the effect has been applied — I8's identity. */
  effectApplied: boolean;
  /** The replay id assigned when this run completed, so duplicates can echo it. */
  replayId?: number;
}

export class ControlPlane {
  private readonly config: ControlPlaneConfig;
  private readonly slots: Slot[] = [];
  private readonly runs = new Map<RunId, RunState>();
  private readonly caps = new Map<TenantId, number>();
  private readonly creditsPerWindow = new Map<TenantId, number>();
  /** Credits spent in the CURRENT window, per tenant. */
  private readonly creditsSpent = new Map<TenantId, number>();
  private currentWindow = 0;
  private nextToken: FencingToken = 1;

  readonly log: ReplayLog;

  // Monotonic counters — never decremented. I3 is built on these.
  private claimsGranted = 0;
  private releasesDone = 0;
  /** Rejected stale/double attempts — observability only, NOT a violation. */
  private staleReleaseAttempts = 0;
  private doubleReleaseAttempts = 0;
  /** Releases the plane ACCEPTED, recorded as facts for the checker to judge. */
  private acceptedReleases: AcceptedRelease[] = [];
  /** slotId -> how many accepted releases in the slot's current generation. */
  private releasesThisGeneration = new Map<string, number>();
  private effectCounts = new Map<string, number>();

  constructor(config: ControlPlaneConfig) {
    this.config = config;
    for (const t of config.tenants) {
      this.caps.set(t.id, t.cap);
      this.creditsPerWindow.set(t.id, t.creditsPerWindow);
      this.creditsSpent.set(t.id, 0);
    }
    for (let i = 0; i < config.poolCapacity; i++) {
      this.slots.push({
        id: `slot-${i}`,
        tenant: null,
        token: 0,
        leaseUntil: 0,
      });
    }
    this.log = new ReplayLog(config.retentionCount, config.retentionTicks);
  }

  // ─── State exposed to the invariant checker ────────────────────────────────

  inFlightByTenant(): ReadonlyMap<TenantId, number> {
    const out = new Map<TenantId, number>();
    for (const t of this.config.tenants) out.set(t.id, 0);
    for (const s of this.slots) {
      if (s.tenant !== null) out.set(s.tenant, (out.get(s.tenant) ?? 0) + 1);
    }
    return out;
  }

  get totalClaimed(): number {
    return this.slots.filter((s) => s.tenant !== null).length;
  }

  get counters() {
    return {
      claimsGranted: this.claimsGranted,
      releasesDone: this.releasesDone,
      acceptedReleases: [...this.acceptedReleases],
      staleReleaseAttempts: this.staleReleaseAttempts,
      doubleReleaseAttempts: this.doubleReleaseAttempts,
    };
  }

  capsMap(): ReadonlyMap<TenantId, number> {
    return this.caps;
  }

  creditsSpentMap(): ReadonlyMap<TenantId, number> {
    return this.creditsSpent;
  }

  effectCountsMap(): ReadonlyMap<string, number> {
    return this.effectCounts;
  }

  /**
   * Roll the tumbling window if `now` has crossed into a new epoch.
   *
   * Tumbling, not sliding (SEMANTICS A1). The accepted cost — a 2x burst across
   * a window boundary — is stated in that row rather than discovered later.
   */
  private rollWindowIfNeeded(now: number): void {
    const window = Math.floor(now / this.config.windowTicks);
    if (window === this.currentWindow) return;
    this.currentWindow = window;
    for (const t of this.config.tenants) this.creditsSpent.set(t.id, 0);
  }

  /**
   * Reclaim expired leases lazily, on demand (SEMANTICS C5).
   *
   * No sweeper: a sweeper is a second concurrent actor whose scheduling becomes
   * another ordering dimension the seed has to control, and keeping the system
   * to one decision-maker is what makes the reference model in M4 tractable.
   * The accepted cost is that a slot can sit expired-but-unreclaimed while
   * nobody is asking for capacity, which is externally invisible.
   */
  private reclaimExpired(now: number): void {
    for (const s of this.slots) {
      if (s.tenant !== null && s.leaseUntil <= now) {
        s.tenant = null;
        this.releasesDone++;
      }
    }
  }

  // ─── Operation 1: admit ────────────────────────────────────────────────────

  /**
   * Admit a run: check cap, check credit, take a slot — as ONE step.
   *
   * SEMANTICS B2 is the reason this reads the way it does. The cap predicate is
   * evaluated at the moment the slot is taken, not before it. Splitting them is
   * the classic race: two concurrent admits both observe `inFlight = cap - 1`,
   * both conclude there is room, and both claim. Because this simulation is
   * single-threaded the split would not fail *here* — which is exactly why the
   * mutant that splits them is in the M5 corpus, and why the substrate injects
   * duplicate and reordered requests to expose it.
   */
  admit(now: number, tenant: TenantId, runId: RunId): AdmitOutcome {
    this.rollWindowIfNeeded(now);
    this.reclaimExpired(now);

    const cap = this.caps.get(tenant);
    if (cap === undefined) return { ok: false, reason: "unknown-tenant" };

    const existing = this.runs.get(runId);
    if (existing?.status === "cancelled") {
      // SEMANTICS D1 — the cancel wins a race with the admit.
      return { ok: false, reason: "cancelled-before-start" };
    }

    // The atomic region begins here. Everything from this point to the slot
    // assignment must be indivisible.
    const inFlight = this.inFlightByTenant().get(tenant) ?? 0;
    if (inFlight >= cap) return { ok: false, reason: "cap-exceeded" };

    const spent = this.creditsSpent.get(tenant) ?? 0;
    const budget = this.creditsPerWindow.get(tenant) ?? 0;
    if (spent >= budget) return { ok: false, reason: "no-credit" };

    const free = this.slots.find((s) => s.tenant === null);
    if (free === undefined) return { ok: false, reason: "pool-full" };

    free.tenant = tenant;
    free.token = this.nextToken++;
    free.leaseUntil = now + this.config.leaseTicks;
    this.releasesThisGeneration.set(free.id, 0);
    this.claimsGranted++;
    // Credit is debited AT CLAIM (SEMANTICS A3) — the single most consequential
    // row in the document. Debiting at admit bills for work that may never run;
    // debiting at completion cannot bound concurrency at all.
    this.creditsSpent.set(tenant, spent + 1);
    this.runs.set(runId, {
      runId,
      tenant,
      slotId: free.id,
      status: "admitted",
      effectApplied: false,
    });
    // The atomic region ends here.

    return { ok: true, slotId: free.id, token: free.token, leaseUntil: free.leaseUntil };
  }

  // ─── Operation 2: release ──────────────────────────────────────────────────

  /**
   * Release a slot, validated by fencing token.
   *
   * A stale holder — one whose lease expired and whose slot was reclaimed and
   * handed to someone else — must NOT be able to release. If it could, it would
   * free a slot another run legitimately owns, and the damage would surface far
   * away as an I1 or I2 violation with no obvious cause. Catching it here is
   * what makes that failure attributable (SEMANTICS C1, C4).
   */
  release(now: number, slotId: SlotId, token: FencingToken): ReleaseOutcome {
    const slot = this.slots.find((s) => s.id === slotId);
    if (slot === undefined) return { ok: false, reason: "not-held" };

    // A slot with no tenant is not held — which covers "already released",
    // "never claimed" and "reclaimed after lease expiry" alike. There is one
    // observable state, so there is one answer.
    if (slot.tenant === null) {
      this.doubleReleaseAttempts++;
      return { ok: false, reason: "not-held" };
    }
    if (slot.token !== token) {
      // Correctly REFUSED. An attempt is not a violation — the fencing token
      // did its job. Recorded as a counter so the corpus can show the case was
      // actually exercised rather than merely possible.
      this.staleReleaseAttempts++;
      return { ok: false, reason: "stale-token" };
    }

    // Accepted. Record the raw facts and let the checker judge them.
    const prior = this.releasesThisGeneration.get(slotId) ?? 0;
    this.acceptedReleases.push({
      slotId,
      tokenUsed: token,
      tokenCurrent: slot.token,
      priorReleasesOfGeneration: prior,
    });
    this.releasesThisGeneration.set(slotId, prior + 1);

    // SEMANTICS D5 — the slot returns to the pool and to the tenant's cap in one
    // step. Any window where one has happened and the other has not is a window
    // where I1 and I2 disagree.
    slot.tenant = null;
    this.releasesDone++;
    void now;
    return { ok: true };
  }

  // ─── Operation 3: complete ─────────────────────────────────────────────────

  /**
   * Record a completion. Idempotent per run.
   *
   * This is KhataGO's claim protocol, generalised: the effect is applied exactly
   * once per identity no matter how many times delivery happens, because the
   * transition to `completed` is a compare-and-set on the run's status rather
   * than a read followed by a write.
   *
   * A duplicate is ACKED, not errored (SEMANTICS E7) — erroring would make the
   * sender retry forever, and at-least-once delivery guarantees duplicates.
   */
  complete(now: number, runId: RunId, outcome: "completed" | "failed"): CompleteOutcome {
    const run = this.runs.get(runId);
    if (run === undefined) return { ok: false, reason: "unknown-run" };

    if (run.status === "cancelled") {
      // SEMANTICS E8 — recorded, but the effect is NOT applied.
      const replayId = this.log.append({
        vtime: now,
        tenant: run.tenant,
        runId,
        outcome: "cancelled",
      });
      void replayId;
      return { ok: false, reason: "completed-after-cancel" };
    }

    if (run.status === "completed") {
      // Already done. Ack the duplicate so the sender stops retrying, and do
      // NOT touch the effect count — that is I8's whole assertion.
      //
      // Return the ORIGINAL replay id. An earlier version searched the log via a
      // helper that always returned undefined, so every duplicate answered with
      // replayId 0 — a caller correlating the ack to a log position would have
      // been silently misled. Mechanical mutation surfaced it: flipping the
      // comparison inside that search changed nothing, which is what dead code
      // looks like from the outside.
      return { ok: true, replayId: run.replayId ?? 0, duplicate: true };
    }

    // The CAS: only the transition out of `admitted` applies the effect.
    run.status = "completed";
    if (!run.effectApplied) {
      run.effectApplied = true;
      this.effectCounts.set(runId, (this.effectCounts.get(runId) ?? 0) + 1);
    }

    // SEMANTICS B6 — completion is terminal and frees capacity atomically with
    // recording the effect. Added as an amendment after the differential oracle
    // caught the gap: the implementation used to hold the slot until an explicit
    // release or lease expiry, so a finished run kept occupying the pool.
    if (run.slotId !== null) {
      const slot = this.slots.find((sl) => sl.id === run.slotId);
      if (slot !== undefined && slot.tenant !== null) {
        slot.tenant = null;
        this.releasesDone++;
      }
    }
    const replayId = this.log.append({
      vtime: now,
      tenant: run.tenant,
      runId,
      outcome,
    });
    run.replayId = replayId;
    this.log.evict(now);
    return { ok: true, replayId, duplicate: false };
  }

  /** Cancel — idempotent (SEMANTICS D4), wins against admit, loses to completion. */
  cancel(now: number, runId: RunId): "cancelled" | "already-complete" | "noop" {
    const run = this.runs.get(runId);
    if (run === undefined) {
      // Cancel arriving before the admit: remember it so the admit loses (D1).
      this.runs.set(runId, {
        runId,
        tenant: "",
        slotId: null,
        status: "cancelled",
        effectApplied: false,
      });
      return "cancelled";
    }
    if (run.status === "completed") return "already-complete"; // D2
    if (run.status === "cancelled") return "noop"; // D4
    run.status = "cancelled";
    if (run.slotId !== null) {
      const slot = this.slots.find((s) => s.id === run.slotId);
      if (slot !== undefined && slot.tenant !== null) {
        slot.tenant = null;
        this.releasesDone++;
      }
    }
    void now;
    return "cancelled";
  }

  /** Independent recomputation of credits, for I4's differential check. */
  creditsExpected(): ReadonlyMap<TenantId, number> {
    const out = new Map<TenantId, number>();
    for (const t of this.config.tenants) out.set(t.id, 0);
    for (const [, run] of sortedMapEntries(
      new Map([...this.runs].map(([k, v]) => [k, v])),
    )) {
      if (run.tenant === "") continue;
      if (run.status === "cancelled" && run.slotId === null) continue;
      out.set(run.tenant, (out.get(run.tenant) ?? 0) + 1);
    }
    return out;
  }
}
