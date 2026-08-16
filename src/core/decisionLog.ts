import { createHash } from "node:crypto";

/**
 * The decision log — the artifact the whole determinism claim is made about.
 *
 * Every decision the control plane makes appends one record. Two runs of the
 * same seed must produce byte-identical logs, and `hashDecisionLog` reduces that
 * to a single comparable value.
 *
 * The log is deliberately the *only* thing compared. Comparing internal state
 * would couple the guard to representation choices and make refactors look like
 * determinism failures; comparing outputs keeps the guard honest about what
 * actually matters — that the system made the same decisions in the same order.
 */

export type DecisionKind =
  | "admit"
  | "reject"
  | "claim"
  | "release"
  | "complete"
  | "ack"
  | "cancel"
  | "expire"
  | "replay-advance";

export interface DecisionRecord {
  /** Monotonic index in the log. Position is part of the identity. */
  readonly seq: number;
  /** Virtual time the decision was taken. */
  readonly vtime: number;
  readonly kind: DecisionKind;
  readonly tenant: string;
  readonly runId: string;
  /** The decision itself, e.g. "granted" / "cap-exceeded" / "no-credit". */
  readonly decision: string;
  /** Why — carried so a failing trace explains itself without a debugger. */
  readonly reason: string;
}

/**
 * Canonical serialization.
 *
 * Field order is FIXED here rather than taken from the object, because
 * `JSON.stringify` emits properties in insertion order — so two records built by
 * different code paths could serialize differently while being semantically
 * identical, and the hash would diverge for no real reason.
 */
export function serializeRecord(r: DecisionRecord): string {
  return JSON.stringify([
    r.seq,
    r.vtime,
    r.kind,
    r.tenant,
    r.runId,
    r.decision,
    r.reason,
  ]);
}

export class DecisionLog {
  private readonly records: DecisionRecord[] = [];

  get length(): number {
    return this.records.length;
  }

  append(entry: Omit<DecisionRecord, "seq">): DecisionRecord {
    const record: DecisionRecord = { seq: this.records.length, ...entry };
    this.records.push(record);
    return record;
  }

  all(): readonly DecisionRecord[] {
    return this.records;
  }

  /** JSONL — one canonical record per line. */
  toJsonl(): string {
    return this.records.map(serializeRecord).join("\n");
  }

  /** SHA-256 over the canonical serialization. This is the determinism check. */
  hash(): string {
    const h = createHash("sha256");
    for (const r of this.records) {
      h.update(serializeRecord(r));
      h.update("\n");
    }
    return h.digest("hex");
  }
}

export function hashDecisionLog(log: DecisionLog): string {
  return log.hash();
}

/** Parse a JSONL log back into records — used by `ballast replay`. */
export function parseJsonl(text: string): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const a = JSON.parse(line) as unknown[];
    if (!Array.isArray(a) || a.length !== 7) {
      throw new Error(`malformed decision record: ${line}`);
    }
    out.push({
      seq: a[0] as number,
      vtime: a[1] as number,
      kind: a[2] as DecisionKind,
      tenant: a[3] as string,
      runId: a[4] as string,
      decision: a[5] as string,
      reason: a[6] as string,
    });
  }
  return out;
}
