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
  | "unknown-tenant";

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
      readonly reason: "stale-token" | "not-held" | "already-released";
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
