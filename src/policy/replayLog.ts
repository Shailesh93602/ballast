import type { LogEntry, ReplayId, SubscribeOutcome } from "./types.js";

/**
 * The durable completion channel, as a replay log.
 *
 * This is the piece that makes the whole system an at-least-once delivery
 * problem rather than a function call. It restates the contract that Salesforce's
 * Pub/Sub API exposes: an append-only log, opaque replay IDs, bounded retention,
 * resubscribe-from-replay-ID, and subscriber-driven credit flow control.
 *
 * THE LOAD-BEARING DESIGN POINT (SEMANTICS E5, E6):
 *
 * A subscriber that runs out of credit PAUSES. It does not drop.
 *
 * That is not a preference — it follows from what the stream is. A completion
 * stream is a *fold*: the subscriber's view of the world is the accumulation of
 * every entry it has seen. Dropping an entry does not degrade that view, it
 * corrupts it, permanently and silently. This is the same argument that governs
 * frame conflation in a video protocol, arrived at from the opposite direction:
 * conflation is sound only when state is reconstructible from the latest value
 * per key, and here it is not, because there is no "latest value" for an event
 * that means "run 7 finished".
 *
 * And credits decrement on ACKNOWLEDGEMENT, not on send (E6). Decrementing on
 * send measures what the publisher emitted rather than what the subscriber
 * absorbed — so a slow or dead subscriber would never apply backpressure, which
 * is the entire point of credit-based flow control. This is a planted mutant in
 * M5.
 */

export interface SubscriberState {
  readonly name: string;
  /** Next replay id this subscriber wants. */
  cursor: ReplayId;
  /** Remaining delivery credits. Zero means paused, never means drop. */
  credits: number;
  /** Entries sent but not yet acknowledged. */
  inFlight: number;
}

/**
 * The largest delivery window a subscriber may be granted — SEMANTICS E9.
 *
 * The number itself is a configuration choice, not a correctness one. What is a
 * correctness choice is that the ceiling belongs to the PUBLISHER: a subscriber
 * that names its own window is not being flow-controlled, it is being asked
 * politely.
 */
export const DEFAULT_MAX_CREDITS = 64;

export class ReplayLog {
  private entries: LogEntry[] = [];
  private nextId: ReplayId = 1;
  /** The oldest id still retained. Ids below this have been evicted. */
  private oldestRetained: ReplayId = 1;
  private readonly retentionCount: number;
  private readonly retentionTicks: number;
  private readonly maxCredits: number;
  /**
   * How many grants have been clamped — observability, not correctness.
   *
   * A paused subscriber looks exactly like a publisher with nothing to send
   * (E10), so an operator debugging a stall needs to be able to tell "it asked
   * for a smaller window" from "something is broken". A silent clamp is the
   * same failure as E2's silent fast-forward, one layer over.
   */
  clampedGrants = 0;

  constructor(
    retentionCount: number,
    retentionTicks: number,
    maxCredits: number = DEFAULT_MAX_CREDITS,
  ) {
    this.retentionCount = retentionCount;
    this.retentionTicks = retentionTicks;
    this.maxCredits = maxCredits;
  }

  /** The publisher's ceiling on a delivery window — SEMANTICS E9. */
  get creditCeiling(): number {
    return this.maxCredits;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Every id ever assigned, in order — what I7 checks for monotonicity. */
  assignedIds(): readonly ReplayId[] {
    return this.entries.map((e) => e.replayId);
  }

  /**
   * Append a completion. Returns its replay id.
   *
   * Ids are strictly increasing and never reused, even across eviction — reusing
   * an id after eviction would make a subscriber's cursor silently point at a
   * different event, which is one of the planted mutants in M5.
   */
  append(entry: Omit<LogEntry, "replayId">): ReplayId {
    const replayId = this.nextId++;
    this.entries.push({ replayId, ...entry });
    return replayId;
  }

  /**
   * Evict past both retention bounds — SEMANTICS E1. Count AND age, because
   * count-only keeps ancient entries alive through a quiet period, and age-only
   * blows memory during a burst.
   */
  evict(now: number): number {
    const before = this.entries.length;
    this.entries = this.entries.filter(
      (e, idx) =>
        this.entries.length - idx <= this.retentionCount &&
        now - e.vtime <= this.retentionTicks,
    );
    const first = this.entries[0];
    if (first !== undefined) this.oldestRetained = first.replayId;
    else this.oldestRetained = this.nextId;
    return before - this.entries.length;
  }

  /**
   * Resubscribe from a replay id.
   *
   * A cursor below what is retained is an ERROR, not a silent fast-forward
   * (SEMANTICS E2). Fast-forwarding would leave the subscriber believing it has
   * a contiguous view when it has a hole, with no way to discover the hole —
   * which is precisely the failure the replay-id contract exists to prevent.
   */
  readFrom(cursor: ReplayId, limit: number): SubscribeOutcome {
    // NOTE the absent `&& this.entries.length > 0`.
    //
    // That clause turned the WORST case into the quiet one: when retention had
    // evicted the log down to nothing, a subscriber holding an evicted cursor
    // was answered `ok: true, entries: []` — "nothing new yet" — for events it
    // had permanently missed. E2 exists to stop exactly that: a hole the
    // subscriber has no way to discover. `oldestRetained` already handles the
    // empty case correctly (evict sets it to `nextId`), so a fresh log still
    // serves a fresh subscriber at cursor 1.
    if (cursor < this.oldestRetained) {
      return { ok: false, reason: "retention-exceeded" };
    }
    const out: LogEntry[] = [];
    for (const e of this.entries) {
      if (e.replayId < cursor) continue;
      if (out.length >= limit) break;
      out.push(e);
    }
    return { ok: true, entries: out };
  }

  /**
   * Deliver to a subscriber, respecting its credit.
   *
   * Returns the entries actually sent. Credits are NOT decremented here — see
   * `acknowledge`. Entries beyond the credit ceiling stay in the log and are
   * delivered later; nothing is dropped.
   */
  deliver(sub: SubscriberState): readonly LogEntry[] {
    const available = sub.credits - sub.inFlight;
    if (available <= 0) return []; // paused, not dropping
    const result = this.readFrom(sub.cursor, available);
    if (!result.ok) return [];
    sub.inFlight += result.entries.length;
    return result.entries;
  }

  /**
   * Acknowledge delivery. THIS is where credit is consumed and the cursor moves.
   *
   * Doing it here rather than in `deliver` is what makes backpressure real: an
   * unresponsive subscriber accumulates `inFlight`, exhausts its window, and
   * stops being sent anything until it catches up.
   *
   * `grantedCredits` IS A REQUEST, NOT A SETTING (SEMANTICS E9). It used to be
   * assigned straight through — `sub.credits = grantedCredits` — so a
   * subscriber could name any window it liked, including one larger than the
   * log, and be sent everything in a single delivery. Credit-based flow control
   * that only constrains the subscribers who choose to be constrained is not
   * flow control. The publisher's ceiling is the decision; the clamp is
   * recorded rather than silent, because a clamped subscriber and a stalled one
   * look identical from the outside.
   *
   * A grant BELOW the outstanding in-flight count is legal and pauses the
   * subscriber (E10) — that is E5's pause reached from the other direction, and
   * it is recoverable because every in-flight entry has already been delivered
   * and can therefore be acknowledged.
   */
  acknowledge(
    sub: SubscriberState,
    upToInclusive: ReplayId,
    grantedCredits: number,
  ): void {
    let acked = 0;
    for (const e of this.entries) {
      if (e.replayId >= sub.cursor && e.replayId <= upToInclusive) acked++;
    }
    sub.inFlight = Math.max(0, sub.inFlight - acked);
    sub.cursor = Math.max(sub.cursor, upToInclusive + 1);

    const bounded = Math.max(0, Math.min(grantedCredits, this.maxCredits));
    if (bounded !== grantedCredits) this.clampedGrants++;
    sub.credits = bounded;
  }
}
