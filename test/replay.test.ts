import { describe, expect, it } from "vitest";

import { serializeRecord, type DecisionRecord } from "../src/core/decisionLog.js";
import { replayTrace } from "../src/core/replay.js";

function record(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    seq: 0,
    vtime: 0,
    kind: "admit",
    tenant: "acme",
    runId: "r1",
    decision: "granted",
    reason: "under cap",
    ...over,
  };
}

function jsonl(records: readonly DecisionRecord[]): string {
  return records.map(serializeRecord).join("\n") + "\n";
}

describe("replay", () => {
  it("summarises a well-formed trace and reports no problems", () => {
    const report = replayTrace(
      jsonl([
        record({ seq: 0, vtime: 0, kind: "admit", tenant: "acme" }),
        record({ seq: 1, vtime: 1, kind: "reject", tenant: "globex" }),
        record({ seq: 2, vtime: 3, kind: "release", tenant: "acme" }),
      ]),
    );

    expect(report.problems).toEqual([]);
    expect(report.records).toBe(3);
    expect(report.tenants).toEqual(["acme", "globex"]);
    expect(report.kindCounts.get("admit")).toBe(1);
    expect(report.kindCounts.get("reject")).toBe(1);
  });

  // The failure this command exists to catch. A shrunk trace that quietly lost
  // records is worse than one that fails loudly: every conclusion drawn from it
  // is about a run that never happened.
  it("detects a spliced or truncated trace via the seq gap", () => {
    const report = replayTrace(
      jsonl([
        record({ seq: 0, vtime: 0 }),
        record({ seq: 7, vtime: 1 }), // 1..6 removed
        record({ seq: 8, vtime: 2 }),
      ]),
    );

    expect(report.problems.length).toBeGreaterThan(0);
    expect(report.problems[0]?.message).toContain("not contiguous");
  });

  it("detects virtual time going backwards", () => {
    // Either the recorder wrote out of order, or two runs were concatenated.
    const report = replayTrace(
      jsonl([record({ seq: 0, vtime: 10 }), record({ seq: 1, vtime: 4 })]),
    );

    expect(report.problems.some((p) => p.message.includes("backwards"))).toBe(true);
  });

  it("detects an unknown decision kind", () => {
    const report = replayTrace(
      jsonl([record({ kind: "teleport" as DecisionRecord["kind"] })]),
    );

    expect(report.problems.some((p) => p.message.includes("unknown decision kind"))).toBe(
      true,
    );
  });

  it("detects a decision with no reason", () => {
    // Nothing downstream reads `reason`, which is exactly why it rots
    // unnoticed — and it is the field that lets a failing trace explain itself
    // without a debugger.
    const report = replayTrace(jsonl([record({ reason: "" })]));

    expect(report.problems.some((p) => p.message.includes("empty reason"))).toBe(true);
  });

  it("accepts equal vtimes — only going BACKWARDS is wrong", () => {
    // Several decisions legitimately share a virtual instant; the (vtime, seq)
    // key is what orders them. Rejecting ties would fail every real trace.
    const report = replayTrace(
      jsonl([
        record({ seq: 0, vtime: 5 }),
        record({ seq: 1, vtime: 5 }),
        record({ seq: 2, vtime: 5 }),
      ]),
    );

    expect(report.problems).toEqual([]);
  });

  it("handles an empty trace without inventing problems", () => {
    const report = replayTrace("");
    expect(report.records).toBe(0);
    expect(report.problems).toEqual([]);
    expect(report.tenants).toEqual([]);
  });

  it("reports EVERY problem, not just the first", () => {
    // A reader that stops at the first defect turns one debugging session into
    // several.
    const report = replayTrace(
      jsonl([record({ seq: 0, reason: "" }), record({ seq: 5, reason: "" })]),
    );

    expect(report.problems.length).toBeGreaterThanOrEqual(3);
  });
});
