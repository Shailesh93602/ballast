import { describe, expect, it } from "vitest";

import { runSale, type Buyer, type StrategyName } from "../src/policy/flashSale.js";

/**
 * One unit, two buyers, and B commits inside A's read-write window.
 *
 * The minimal interleaving that separates a correct claim from an incorrect
 * one. Everything else in this file is a generalisation of it.
 */
const LAST_UNIT_RACE: Buyer[] = [{ id: "A", interleavedBy: ["B"] }, { id: "B" }];

describe("flash sale — the naive strategy oversells", () => {
  // If this ever passes, the test has stopped testing anything. The whole file
  // is built on read-then-write being genuinely broken under this interleaving.
  it("read-then-write sells the last unit TWICE", () => {
    const report = runSale("read-then-write", 1, LAST_UNIT_RACE);

    expect(report.sold).toBe(2);
    expect(report.oversold).toBe(1);
  });

  it("...and every read it made was correct when it happened", () => {
    // Why this survives review. Neither buyer read a stale value: A read 1 and
    // there was 1, B read 1 and there was 1. The bug is not in the read, it is
    // in acting on it after it stopped being true.
    const report = runSale("read-then-write", 1, LAST_UNIT_RACE);
    expect(report.outcomes.every((o) => !o.reason.includes("stale"))).toBe(true);
    expect(report.oversold).toBeGreaterThan(0);
  });
});

/**
 * The assertions every correct strategy must satisfy, shared so the two blocks
 * below cannot drift apart.
 *
 * Written as helpers rather than `describe.each` on purpose: this repo's README
 * guard counts `it(` occurrences in source, and `.each` expands at runtime, so
 * using it would make the published test count wrong. A checkable number is
 * worth more than the terser syntax.
 */
function expectsSellsExactlyOne(strategy: StrategyName): void {
  const report = runSale(strategy, 1, LAST_UNIT_RACE);
  expect(report.oversold).toBe(0);
  expect(report.sold).toBe(1);
  expect(report.refused).toBe(1);
}

function expectsNeverExceedsStock(strategy: StrategyName): void {
  // 50 buyers for 5 units, every buyer interleaved by the next three. If a
  // window exists anywhere, this finds it.
  const buyers: Buyer[] = Array.from({ length: 50 }, (_, i) => ({
    id: `b${i}`,
    interleavedBy: [`b${i + 1}`, `b${i + 2}`, `b${i + 3}`].filter(
      (id) => Number(id.slice(1)) < 50,
    ),
  }));
  const report = runSale(strategy, 5, buyers);
  expect(report.oversold).toBe(0);
  expect(report.sold).toBe(5);
}

function expectsSellsEverythingUncontended(strategy: StrategyName): void {
  // The failure mode in the other direction, and why "oversold === 0" is not
  // sufficient alone: a strategy that refuses everyone scores a perfect zero.
  const buyers: Buyer[] = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}` }));
  const report = runSale(strategy, 5, buyers);
  expect(report.sold).toBe(5);
  expect(report.refused).toBe(0);
}

function expectsRefusesAtZeroStock(strategy: StrategyName): void {
  const report = runSale(strategy, 0, [{ id: "A" }, { id: "B" }]);
  expect(report.sold).toBe(0);
  expect(report.oversold).toBe(0);
  expect(report.outcomes.every((o) => o.reason === "sold out")).toBe(true);
}

describe("flash sale — conditional-update never oversells", () => {
  it("sells exactly one unit under the last-unit race", () => {
    expectsSellsExactlyOne("conditional-update");
  });

  it("never exceeds stock at any size, under heavy contention", () => {
    expectsNeverExceedsStock("conditional-update");
  });

  it("sells everything when there is no contention — it is not just refusing", () => {
    expectsSellsEverythingUncontended("conditional-update");
  });

  it("refuses cleanly when stock is zero", () => {
    expectsRefusesAtZeroStock("conditional-update");
  });
});

describe("flash sale — optimistic-version never oversells", () => {
  it("sells exactly one unit under the last-unit race", () => {
    expectsSellsExactlyOne("optimistic-version");
  });

  it("never exceeds stock at any size, under heavy contention", () => {
    expectsNeverExceedsStock("optimistic-version");
  });

  it("sells everything when there is no contention — it is not just refusing", () => {
    expectsSellsEverythingUncontended("optimistic-version");
  });

  it("refuses cleanly when stock is zero", () => {
    expectsRefusesAtZeroStock("optimistic-version");
  });
});

describe("flash sale — the cost of each correct strategy", () => {
  // The comparison that is actually informative. Both are correct; they differ
  // in what correctness costs under contention.
  it("optimistic concurrency pays retries that a conditional update does not", () => {
    const buyers: Buyer[] = Array.from({ length: 20 }, (_, i) => ({
      id: `b${i}`,
      interleavedBy: [`b${i + 1}`].filter((id) => Number(id.slice(1)) < 20),
    }));

    const conditional = runSale("conditional-update", 10, buyers);
    const optimistic = runSale("optimistic-version", 10, buyers);

    expect(conditional.oversold).toBe(0);
    expect(optimistic.oversold).toBe(0);

    // A conditional update cannot lose a race — there is no window to lose in.
    expect(conditional.totalRetries).toBe(0);
    // Optimistic concurrency can, and does. That is the tradeoff, not a defect:
    // it buys the ability to express updates a WHERE clause cannot.
    expect(optimistic.totalRetries).toBeGreaterThan(0);
  });

  it("retry exhaustion refuses rather than overselling", () => {
    // The dangerous shortcut: treating "I ran out of retries" as success
    // because the buyer probably would have won. It converts a correctness
    // guarantee into a probabilistic one.
    const buyers: Buyer[] = [
      { id: "A", interleavedBy: ["B", "C", "D", "E", "F", "G"] },
      ...["B", "C", "D", "E", "F", "G"].map((id) => ({ id })),
    ];

    const report = runSale("optimistic-version", 3, buyers);

    expect(report.oversold).toBe(0);
    expect(report.sold).toBeLessThanOrEqual(3);
  });
});

function expectsDeterministic(strategy: StrategyName): void {
  // This repo's whole premise: a failure that replays is a bug, one that does
  // not is a research project.
  const buyers: Buyer[] = Array.from({ length: 12 }, (_, i) => ({
    id: `b${i}`,
    interleavedBy: [`b${i + 1}`].filter((id) => Number(id.slice(1)) < 12),
  }));
  const first = runSale(strategy, 4, buyers);
  const second = runSale(strategy, 4, buyers);
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
}

describe("flash sale — determinism", () => {
  it("read-then-write replays identically, oversell included", () => {
    expectsDeterministic("read-then-write");
  });

  it("conditional-update replays identically", () => {
    expectsDeterministic("conditional-update");
  });

  it("optimistic-version replays identically, retries included", () => {
    expectsDeterministic("optimistic-version");
  });
});

describe("flash sale — the oversell count cannot be self-reported", () => {
  it("is derived from outcomes, not from the strategy's own tally", () => {
    // A strategy that miscounted its sales could otherwise report zero
    // oversells while overselling — the checker trusting the thing it checks,
    // which is exactly the bug LEDGER.md L1 records.
    const report = runSale("read-then-write", 1, LAST_UNIT_RACE);
    const soldFromOutcomes = report.outcomes.filter((o) => o.sold).length;

    expect(report.sold).toBe(soldFromOutcomes);
    expect(report.oversold).toBe(Math.max(0, soldFromOutcomes - report.initialStock));
  });
});
