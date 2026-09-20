/**
 * The control-plane surface.
 *
 * THREE OPERATIONS. That is the whole API, and keeping it at three is a design
 * decision, not an accident of scope.
 *
 * Every additional operation is another thing that needs its own acceptance
 * testing, and breadth is what made the reference project in this workspace
 * (EduScale) expensive: many shallow features, each needing a human to say "yes
 * that looks right", so weeks went into testing and no depth came out. Here the
 * surface is narrow and the depth is behind it — eight invariants, a reference
 * oracle, a mutation corpus and a shrinker all pointed at three entry points.
 */

export type TenantId = string;
export type RunId = string;
export type SlotId = string;
export type FencingToken = number;
export type ReplayId = number;

/** Why an admission was refused. Distinguishable on purpose — SEMANTICS B5. */
export type RejectReason =
  | "cap-exceeded"
  | "pool-full"
  | "no-credit"
  | "cancelled-before-start"
  /** The runId already completed. Identities are single-use — SEMANTICS A9. */
  | "run-already-terminal"
  | "unknown-tenant";

/**
 * The order in which SIMULTANEOUSLY-TRUE refusal conditions are reported —
 * SEMANTICS B7.
 *
 * B3 and B4 each name the reason that applies when ONE condition holds. Neither
 * says what happens when two hold at once, and both engines happened to evaluate
 * cap → credit → pool because both were written by one author in one sitting.
 * That is the shared-spec blind spot in its purest form: the differential
 * compares the reason, which makes it LOOK covered, while both halves derive the
 * order from the same unwritten decision.
 *
 * So the order is written down ONCE, here, and:
 *
 *   - `test/precedence.test.ts` asserts this array against the order declared in
 *     docs/SEMANTICS.md B7, so the constant cannot drift from the spec;
 *   - the reference oracle RESOLVES through this array instead of
 *     short-circuiting, so it no longer encodes an order of its own;
 *   - the implementation keeps its own short-circuit order in source, so a
 *     divergence between the two is a test failure rather than a silent
 *     agreement.
 *
 * The engines still share this table — but they can no longer agree on it
 * SILENTLY, which is the property that was missing.
 */
export const REJECTION_PRECEDENCE = [
  "unknown-tenant",
  "cancelled-before-start",
  "run-already-terminal",
  "cap-exceeded",
  "no-credit",
  "pool-full",
] as const satisfies readonly RejectReason[];

/**
 * A slot-freeing the control plane ACCEPTED, recorded as a raw fact.
 *
 * THIS TYPE LIVES WITH THE PRODUCER, NOT THE CHECKER. `controlPlane.ts` used to
 * import it from `oracle/invariants.ts`, so the policy layer depended on the
 * thing grading it and the shape of the evidence was defined by the grader. The
 * dependency now points the way the data flows: the plane emits facts, the
 * oracle consumes them.
 *
 * That is a direction fix, not a structural one — see the note on
 * `CheckableState.slotOwnerToken`, which is the part that actually reduces the
 * plane's control over what the checker sees.
 */
export interface AcceptedRelease {
  readonly slotId: string;
  /** The token the releasing party presented. */
  readonly tokenUsed: number;
  /** The token the slot actually held when the release was accepted. */
  readonly tokenCurrent: number;
  /** How many times this slot had already been released in this generation. */
  readonly priorReleasesOfGeneration: number;
}

export type AdmitOutcome =
  | {
      readonly ok: true;
      readonly slotId: SlotId;
      readonly token: FencingToken;
      readonly leaseUntil: number;
    }
  | { readonly ok: false; readonly reason: RejectReason };

export type ReleaseOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      // No "already-released": a released slot has no tenant, so it is
      // indistinguishable from never-claimed and reclaimed-after-expiry. One
      // observable state, one answer.
      readonly reason: "stale-token" | "not-held";
    };

export type CompleteOutcome =
  | { readonly ok: true; readonly replayId: ReplayId; readonly duplicate: boolean }
  | { readonly ok: false; readonly reason: "unknown-run" | "completed-after-cancel" };

export interface TenantConfig {
  readonly id: TenantId;
  /** Max concurrently CLAIMED slots — SEMANTICS B1. */
  readonly cap: number;
  /** Credits per tumbling window — SEMANTICS A1, A2. */
  readonly creditsPerWindow: number;
}

export interface ControlPlaneConfig {
  readonly tenants: readonly TenantConfig[];
  readonly poolCapacity: number;
  /** Tumbling window length in ticks — SEMANTICS A2. */
  readonly windowTicks: number;
  /** How long a claim is valid before it can be reclaimed — SEMANTICS C2. */
  readonly leaseTicks: number;
  /** Replay-log retention: both bounds apply — SEMANTICS E1. */
  readonly retentionCount: number;
  readonly retentionTicks: number;
}

export const DEFAULT_CONTROL_PLANE: ControlPlaneConfig = {
  tenants: [
    { id: "acme", cap: 3, creditsPerWindow: 12 },
    { id: "globex", cap: 3, creditsPerWindow: 12 },
    { id: "initech", cap: 2, creditsPerWindow: 8 },
  ],
  poolCapacity: 6,
  windowTicks: 100,
  leaseTicks: 40,
  retentionCount: 64,
  retentionTicks: 500,
};

/**
 * A completion event as it appears in the replay log.
 *
 * `replayId` is opaque to subscribers (SEMANTICS E3): they may compare it for
 * equality and hand it back, nothing else. It is monotonic internally, which is
 * what I7 asserts.
 */
export interface LogEntry {
  readonly replayId: ReplayId;
  readonly vtime: number;
  readonly tenant: TenantId;
  readonly runId: RunId;
  readonly outcome: "completed" | "failed" | "cancelled";
}

export type SubscribeOutcome =
  | { readonly ok: true; readonly entries: readonly LogEntry[] }
  | { readonly ok: false; readonly reason: "retention-exceeded" };
