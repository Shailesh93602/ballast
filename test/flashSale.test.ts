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
  // The row must agree with the outcomes. Without this, a decrement that
  // subtracts the wrong amount — or does nothing — passes every check above.
  expect(report.remainingStock).toBe(0);
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
  expect(report.remainingStock).toBe(0);
}

function expectsSellsEverythingUncontended(strategy: StrategyName): void {
  // The failure mode in the other direction, and why "oversold === 0" is not
  // sufficient alone: a strategy that refuses everyone scores a perfect zero.
  const buyers: Buyer[] = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}` }));
  const report = runSale(strategy, 5, buyers);
  expect(report.sold).toBe(5);
  expect(report.refused).toBe(0);
  expect(report.remainingStock).toBe(0);
}

function expectsRefusesAtZeroStock(strategy: StrategyName): void {
  const report = runSale(strategy, 0, [{ id: "A" }, { id: "B" }]);
  expect(report.sold).toBe(0);
  expect(report.oversold).toBe(0);
  expect(report.outcomes.every((o) => o.reason === "sold out")).toBe(true);
  // Never negative. A guard written as `stock < 0` instead of `stock <= 0`
  // passes every other assertion here and drives the row to -1.
  expect(report.remainingStock).toBe(0);
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

describe("flash sale — the row must never go negative", () => {
  // The boundary a `<= 0` vs `< 0` guard turns on, and the one every strategy
  // has to get right independently. Mutation testing flagged this: flipping
  // that comparison survived, because nothing was looking at the row.
  it("conditional-update leaves the row at zero, not below", () => {
    const buyers: Buyer[] = Array.from({ length: 10 }, (_, i) => ({
      id: `b${i}`,
    }));
    const report = runSale("conditional-update", 3, buyers);
    expect(report.remainingStock).toBe(0);
    expect(report.sold).toBe(3);
  });

  it("optimistic-version leaves the row at zero, not below", () => {
    const buyers: Buyer[] = Array.from({ length: 10 }, (_, i) => ({
      id: `b${i}`,
    }));
    const report = runSale("optimistic-version", 3, buyers);
    expect(report.remainingStock).toBe(0);
    expect(report.sold).toBe(3);
  });

  it("read-then-write oversells by exactly one AND leaves the row wrong", () => {
    // Both halves matter. The oversell is the visible symptom; the row being
    // inconsistent with the sales is the durable damage, because the next sale
    // reads that row.
    const report = runSale("read-then-write", 1, LAST_UNIT_RACE);
    expect(report.sold).toBe(2);
    expect(report.oversold).toBe(1);
    // Two units sold from a row that only ever decremented once.
    expect(report.remainingStock).toBe(0);
  });
});

describe("flash sale — retry budget", () => {
  it("uses every attempt before refusing, and refuses rather than overselling", () => {
    // Pins the retry bound. An off-by-one silently reduces how much contention
    // the strategy absorbs, which looks like nothing until a burst refuses
    // buyers it should have served.
    //
    // This case only exists because contention is sustained. When every
    // contender committed during attempt 1, the retry could fail at most once
    // and this branch was unreachable — dead code dressed as defensive
    // programming, found by a reachability probe over every stock/buyer shape.
    const ids = ["b0", "b1", "b2", "b3", "b4", "b5"];
    const buyers: Buyer[] = ids.map((id, i) => ({
      id,
      interleavedBy: ids.slice(i + 1),
    }));

    const report = runSale("optimistic-version", 5, buyers);
    const exhausted = report.outcomes.find((o) => o.reason === "retry limit reached");

    expect(exhausted).toBeDefined();
    expect(exhausted!.attempts).toBe(5);
    // The important half: giving up is a REFUSAL. Treating retry exhaustion as
    // a sale — on the grounds the buyer probably would have won — converts a
    // correctness guarantee into a probabilistic one.
    expect(exhausted!.sold).toBe(false);
    expect(report.oversold).toBe(0);
  });
});

describe("flash sale — the row's own arithmetic", () => {
  // These exist because mutation testing changed the arithmetic INSIDE the row
  // and every behavioural assertion still passed. Sales were counted from
  // outcomes, so nothing noticed the row disagreeing with them.

  it("read-then-write does not drive the row below zero at exactly zero stock", () => {
    // The `<= 0` vs `< 0` boundary. With `< 0`, a read of exactly 0 is treated
    // as "in stock" and the row is written to -1.
    const report = runSale("read-then-write", 0, [{ id: "A" }, { id: "B" }]);

    expect(report.sold).toBe(0);
    expect(report.remainingStock).toBe(0);
  });

  it("read-then-write decrements by exactly one on the interleaved path", () => {
    // Two units, and B commits inside A's window. The lost update means A
    // overwrites B's decrement, so exactly one unit is consumed from the row
    // while two are sold. Off-by-one in either write changes that number.
    const report = runSale("read-then-write", 2, [
      { id: "A", interleavedBy: ["B"] },
      { id: "B" },
    ]);

    expect(report.sold).toBe(2);
    // The damage: two sales, one decrement. The row now over-reports stock.
    expect(report.remainingStock).toBe(1);
  });

  it("optimistic-version detects a concurrent write via the version", () => {
    // If the version stops incrementing, compare-and-set can no longer tell
    // that anyone wrote, and the retry that proves the mechanism works never
    // happens.
    const report = runSale("optimistic-version", 5, [
      { id: "A", interleavedBy: ["B"] },
      { id: "B" },
    ]);

    expect(report.totalRetries).toBeGreaterThan(0);
    expect(report.oversold).toBe(0);
    // Two buyers, two units gone.
    expect(report.remainingStock).toBe(3);
  });
});

describe("flash sale — a trace must explain itself accurately", () => {
  // `reason` is not decoration. This repo's premise is that a recorded history
  // is the artifact you debug from, so a trace that mislabels WHY something
  // happened is wrong in the way that matters most — it sends the next person
  // looking in the wrong place.

  it("labels an interleaved winner as sold, not as sold out", () => {
    const report = runSale("conditional-update", 5, [
      { id: "A", interleavedBy: ["B"] },
      { id: "B" },
    ]);

    const b = report.outcomes.find((o) => o.buyer === "B")!;
    expect(b.sold).toBe(true);
    expect(b.reason).toBe("sold (interleaved)");
  });

  it("labels an interleaved loser as sold out, not as sold", () => {
    const report = runSale("conditional-update", 1, [
      { id: "A", interleavedBy: ["B", "C"] },
      { id: "B" },
      { id: "C" },
    ]);

    const losers = report.outcomes.filter((o) => !o.sold);
    expect(losers.length).toBeGreaterThan(0);
    expect(losers.every((o) => o.reason === "sold out")).toBe(true);
    expect(report.sold).toBe(1);
  });

  it("distinguishes a first-attempt sale from one that needed retries", () => {
    // `attempt === 1 ? "sold" : "sold after N retries"` — collapsing these
    // hides contention entirely, which is the one thing this strategy exists
    // to make visible.
    const uncontended = runSale("optimistic-version", 5, [{ id: "A" }]);
    expect(uncontended.outcomes[0]!.reason).toBe("sold");

    const contended = runSale("optimistic-version", 5, [
      { id: "A", interleavedBy: ["B"] },
      { id: "B" },
    ]);
    const a = contended.outcomes.find((o) => o.buyer === "A")!;
    expect(a.sold).toBe(true);
    expect(a.reason).toBe("sold after 1 retries");
    expect(a.attempts).toBe(2);
  });

  it("does not process a buyer twice once it has been interleaved", () => {
    // The `consumed` guard. Negated, a buyer pulled into someone else's window
    // is also processed in its own turn — buying twice.
    const report = runSale("conditional-update", 5, [
      { id: "A", interleavedBy: ["B"] },
      { id: "B" },
    ]);

    expect(report.outcomes.filter((o) => o.buyer === "B")).toHaveLength(1);
    expect(report.outcomes).toHaveLength(2);
    expect(report.remainingStock).toBe(3);
  });
});
