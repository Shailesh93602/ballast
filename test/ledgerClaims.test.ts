import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The ledger's own headline ratio was the one number in this repo that nothing
 * computed.
 *
 * L17 records exactly this defect ("38 of 60" written in four places and
 * produced by none) and the fix was to build the pattern from the constant.
 * The ledger's own sentence — "N of M findings were in the checking apparatus"
 * — was then left hand-written, and no test read LEDGER.md at all. By the time
 * anyone checked it said "sixteen of twenty-seven" against a table holding
 * twenty-nine rows, and a third number was in circulation elsewhere. Three
 * values, none derived.
 *
 * So: both numbers come from the table, and the classification that produces
 * the numerator is written here rather than left to a reader's judgement. If
 * a new severity word appears, this fails rather than guessing — an unknown
 * category silently counted as "system under test" would flatter the ratio,
 * which is the direction that matters.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = readFileSync(join(ROOT, "docs/LEDGER.md"), "utf8");

/** A defect in the machinery that does the checking, not in the thing checked. */
const APPARATUS = new Set(["harness", "harness bug", "checker", "reference", "corpus"]);
/** A defect in the system under test, or a gap in what it was told to be. */
const UNDER_TEST = new Set(["correctness", "spec gap", "dead code"]);

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "twenty-one",
  "twenty-two",
  "twenty-three",
  "twenty-four",
  "twenty-five",
  "twenty-six",
  "twenty-seven",
  "twenty-eight",
  "twenty-nine",
  "thirty",
  "thirty-one",
  "thirty-two",
  "thirty-three",
  "thirty-four",
  "thirty-five",
];
const word = (n: number): string => {
  const w = WORDS[n];
  if (w === undefined) throw new Error(`extend WORDS past ${n}`);
  return w;
};

function rows(): { id: string; severity: string }[] {
  return LEDGER.split("\n")
    .filter((l) => /^\| L\d+ /.test(l))
    .map((l) => {
      const cells = l.split("|").map((c) => c.trim());
      // strip the leading emoji and any surrounding whitespace
      const severity = (cells[3] ?? "").replace(/^[^\p{L}]+/u, "").trim();
      return { id: cells[1] ?? "", severity };
    });
}

describe("the ledger's headline ratio", () => {
  it("has a row per L-number, with no gaps and no duplicates", () => {
    const ids = rows().map((r) => Number(r.id.slice(1)));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
  });

  it("classifies every severity — an unknown one must fail, not be assumed", () => {
    const unknown = rows()
      .map((r) => r.severity)
      .filter((s) => !APPARATUS.has(s) && !UNDER_TEST.has(s));
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("states the ratio the table actually produces", () => {
    const all = rows();
    const apparatus = all.filter((r) => APPARATUS.has(r.severity)).length;
    const flat = LEDGER.replace(/\s+/g, " ");
    const m = flat.match(/([\w-]+) of ([\w-]+) findings were in the checking apparatus/i);
    expect(
      m,
      "the ledger no longer states its ratio in the expected shape",
    ).not.toBeNull();
    const [, numeratorWord = "", totalWord = ""] = m ?? [];
    expect({
      numerator: numeratorWord.toLowerCase(),
      total: totalWord.toLowerCase(),
    }).toEqual({
      numerator: word(apparatus),
      total: word(all.length),
    });
  });
});
