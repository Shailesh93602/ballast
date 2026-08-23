import { type DecisionRecord, parseJsonl } from "./decisionLog.js";

/**
 * Offline replay of a recorded trace.
 *
 * WHY THIS EXISTS SEPARATELY FROM `simulate`.
 *
 * `simulate --seed N` reproduces a run by RE-EXECUTING it. That is the right
 * primitive, and it has one property that hurts when you are debugging: the
 * answer depends on the code being unchanged. The moment you edit the policy to
 * investigate, the seed no longer reproduces the trace you were looking at.
 *
 * A recorded trace is a fixed artifact. Replaying it is seedless, offline, and
 * independent of the current source, so a shrunk failure stays reproducible
 * across the very edits you are making to fix it. It is also what makes a
 * shrunk trace shareable — the file is the repro, no seed and no version pin.
 *
 * Replay is deliberately a READER, not a simulator: it re-derives state from
 * the log and re-runs the checks. It cannot invent an event the log does not
 * contain, which is exactly the property that makes it trustworthy as a check
 * on the thing that produced the log.
 */

export interface ReplayProblem {
  readonly seq: number;
  readonly message: string;
}

export interface ReplayReport {
  readonly records: number;
  readonly problems: readonly ReplayProblem[];
  /** Counts by decision kind — the shape of the trace at a glance. */
  readonly kindCounts: ReadonlyMap<string, number>;
  readonly tenants: readonly string[];
}

const KINDS = new Set<DecisionRecord["kind"]>([
  "admit",
  "reject",
  "claim",
  "release",
  "complete",
  "ack",
  "cancel",
  "expire",
  "replay-advance",
]);

/**
 * Structural checks over a recorded trace.
 *
 * These are the properties that must hold of any log this system emits,
 * independent of policy. A trace that fails one of them means the RECORDER is
 * wrong, which is worth knowing separately from a policy violation — a corrupt
 * log makes every downstream conclusion meaningless, including the reassuring
 * ones.
 */
export function replayTrace(text: string): ReplayReport {
  const records = parseJsonl(text);
  const problems: ReplayProblem[] = [];
  const kindCounts = new Map<string, number>();
  const tenants = new Set<string>();

  let previousVtime = Number.NEGATIVE_INFINITY;

  // An explicit indexed loop rather than forEach: this repo bans `x.forEach`
  // so that iteration order is visible at the call site, and here the index is
  // load-bearing anyway — `seq` is checked against the record's POSITION.
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record === undefined) continue;

    // `seq` is the record's identity, not a decoration. A gap means the trace
    // was truncated or spliced, and a shrunk trace that lost records silently
    // is worse than one that fails loudly.
    if (record.seq !== index) {
      problems.push({
        seq: record.seq,
        message: `seq is ${record.seq} but the record is at position ${index} — the trace is not contiguous`,
      });
    }

    // Virtual time never goes backwards. If it does, either the recorder wrote
    // out of order or the file was concatenated from two runs.
    if (record.vtime < previousVtime) {
      problems.push({
        seq: record.seq,
        message: `vtime went backwards: ${record.vtime} after ${previousVtime}`,
      });
    }
    previousVtime = record.vtime;

    if (!KINDS.has(record.kind)) {
      problems.push({
        seq: record.seq,
        message: `unknown decision kind "${record.kind}"`,
      });
    }

    // Every decision must say why. The reason field is what lets a failing
    // trace explain itself without a debugger, so an empty one is a defect in
    // the recorder even though nothing downstream reads it.
    if (record.reason === "") {
      problems.push({
        seq: record.seq,
        message: `empty reason on a ${record.kind} decision`,
      });
    }

    kindCounts.set(record.kind, (kindCounts.get(record.kind) ?? 0) + 1);
    if (record.tenant !== "") tenants.add(record.tenant);
  }

  return {
    records: records.length,
    problems,
    kindCounts,
    tenants: [...tenants].sort(),
  };
}
