import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { DEFAULT_CONFIG, NaivePolicy, runSimulation } from "../src/core/simulate.js";
import {
  FAIRNESS_SEEDS,
  cappedStarvation,
  cappedWorstDegradation,
  fifoStarvation,
} from "./support/fairnessHarness.js";

/**
 * The README's numbers must be reproducible.
 *
 * This exists because of a specific, documented failure in the workspace this
 * project came out of: a portfolio advertised a "Redis-backed idempotency guard"
 * for a codebase with no Redis dependency, a demo claimed 48 tests whose suite
 * re-implemented the thing it verified, and three separate projects shipped a
 * test count that disagreed with the repo. Every one of those was written
 * honestly and then went stale.
 *
 * So the numbers are not maintained by discipline. They are asserted.
 *
 * The rule: any figure quoted in README.md must be produced by something in this
 * repository, and this test fails when it is not. If a number here becomes
 * inconvenient, the honest move is to delete the claim — not to loosen the test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

function testFiles(): string[] {
  return readdirSync(join(root, "test"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(root, "test", f), "utf8"));
}

/** Test sources INCLUDING shared harnesses, for checks about corpus sizes. */
function allTestSources(): string[] {
  const support = readdirSync(join(root, "test", "support"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(root, "test", "support", f), "utf8"));
  return [...testFiles(), ...support];
}

/**
 * Count `it(` occurrences across the suite — the honest test count.
 *
 * Any indentation, not exactly two spaces: a test inside a nested `describe`
 * is still a test vitest runs, and a counter that skipped it would let the
 * README under-report while the suite grew.
 */
function countTests(): number {
  return testFiles().reduce((n, src) => n + (src.match(/^\s+it\(/gm) ?? []).length, 0);
}

/**
 * Test files where an `it(` sits inside a loop.
 *
 * `countTests` is a static regex over the source: one `it(` written inside a
 * `for` over ten fixtures is one match and ten tests. The README would then
 * under-report a growing suite while this file stayed green — the counter
 * disagreeing with the thing it counts, which is the failure this whole file
 * exists to prevent. Caught by writing exactly that loop.
 */
function filesWithLoopGeneratedTests(): string[] {
  const names = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.ts"));
  return names.filter((name) => {
    const lines = readFileSync(join(root, "test", name), "utf8").split("\n");
    return lines.some((line, i) => {
      if (!/^\s*(for|while)\s*\(/.test(line)) return false;
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      // An `it(` nested deeper than the loop header, before the loop closes.
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? "";
        if (next.trim() === "") continue;
        const nextIndent = /^\s*/.exec(next)?.[0].length ?? 0;
        if (nextIndent <= indent) return false;
        if (/^\s*it\(/.test(next)) return true;
      }
      return false;
    });
  });
}

describe("README numbers are reproducible", () => {
  it("the quoted test count matches the suite", () => {
    const claimed = /\*\*(\d+) tests\*\*/.exec(readme)?.[1];
    expect(claimed, "README must quote a test count").toBeDefined();
    const actual = countTests();
    expect(
      Number(claimed),
      `README claims ${claimed} tests; the suite defines ${actual}. ` +
        `Update the README or delete the claim — do not loosen this test.`,
    ).toBe(actual);
  });

  it("no test is generated inside a loop, which would defeat that counter", () => {
    expect(
      filesWithLoopGeneratedTests(),
      "a loop writes one `it(` and runs many, so the README's count would " +
        "silently drift below the real suite size",
    ).toEqual([]);
  });

  it("the quoted mutation score matches MUTATION.md", () => {
    const claimed = /\*\*([\d.]+)% mutation score\*\*/.exec(readme)?.[1];
    expect(claimed, "README must quote a mutation score").toBeDefined();

    const report = readFileSync(join(root, "docs", "MUTATION.md"), "utf8");
    const reported = /\*\*Mutation score: ([\d.]+)%\*\*/.exec(report)?.[1];
    expect(reported, "MUTATION.md must report a score").toBeDefined();

    expect(
      Number(claimed),
      `README says ${claimed}%, MUTATION.md says ${reported}% — regenerate with ` +
        `\`node scripts/mutate.mjs\` and update the README`,
    ).toBe(Number(reported));
  });

  it("the quoted killed/total matches MUTATION.md", () => {
    const claimed = /\((\d+) of (\d+) mechanical mutants killed\)/.exec(readme);
    expect(claimed, "README must quote killed/total").not.toBeNull();

    const report = readFileSync(join(root, "docs", "MUTATION.md"), "utf8");
    const killed = /- Killed: \*\*(\d+)\*\*/.exec(report)?.[1];
    const generated = /- Mutants generated: \*\*(\d+)\*\*/.exec(report)?.[1];

    expect(Number(claimed?.[1]), "killed count").toBe(Number(killed));
    expect(Number(claimed?.[2]), "total mutants").toBe(Number(generated));
  });

  it("every corpus size named in the README appears in a test", () => {
    // Guards against a corpus being quietly shrunk to make CI faster while the
    // README keeps advertising the old, larger number.
    const sources = allTestSources().join("\n");
    const corpusClaims: Array<{ label: string; needle: RegExp }> = [
      { label: "1,000 determinism seeds", needle: /SEED_COUNT = 1000/ },
      { label: "2,000 invariant histories", needle: /seed <= 2000/ },
      { label: "300 differential histories", needle: /seed <= 300/ },
      { label: "500 KhataGO protocol runs", needle: /seed <= 500/ },
      { label: "60 fairness seeds", needle: /seed <= 60/ },
      { label: "200 quiescence seeds", needle: /SEEDS = 200/ },
      {
        label: "9 precedence overlap scenarios",
        needle: /const SCENARIOS: Scenario\[\]/,
      },
    ];
    const missing = corpusClaims
      .filter((c) => !c.needle.test(sources))
      .map((c) => c.label);
    expect(missing, "README quotes a corpus size no test actually runs").toEqual([]);
  });

  it("the 16 semantic mutants claimed are all present", () => {
    const src = readFileSync(join(root, "test", "mutants.test.ts"), "utf8");
    const count = (src.match(/it\("M\d+:/g) ?? []).length;
    const claimed = /\*\*(\d+) of \d+\*\* semantic mutants/.exec(readme)?.[1];
    expect(Number(claimed), `README claims ${claimed}, file defines ${count}`).toBe(
      count,
    );
  });

  /**
   * THE STARVATION FIGURE IS COMPUTED, NOT MATCHED AGAINST A LITERAL.
   *
   * This block used to assert that README.md matched a regex containing the
   * literal "38 of 60". The 38 existed in four places — README.md, twice in
   * docs/FAIRNESS.md, and here
   * — and was produced by none of them: `fairness.test.ts` only ever asserted
   * `starvedSeeds > 0`. So the guard asserted that the README still said what
   * the README said. Had the policy changed and the real number become 41,
   * every one of the 209 tests would have stayed green while three documents
   * quoted a figure no run reproduced.
   *
   * It is now run, and the pattern is BUILT FROM the result rather than
   * written beside it — the same correction this workspace applied after
   * `claims-consistency.test.ts` hardcoded the very number it existed to catch
   * going stale.
   */
  describe("the fairness figures are produced by running the measurement", () => {
    const fairnessDoc = readFileSync(join(root, "docs", "FAIRNESS.md"), "utf8");
    const { starvedSeeds } = fifoStarvation();

    it("the isolation claim is an exact assertion, not a tolerance", () => {
      expect(readme).toContain("**1.000×**");
      expect(cappedWorstDegradation(), "per-tenant caps must cost exactly nothing").toBe(
        1,
      );
    });

    it("README's starvation count is the count the run produces", () => {
      expect(
        readme,
        `the measured figure is ${starvedSeeds} of ${FAIRNESS_SEEDS}`,
      ).toMatch(new RegExp(`\\*\\*${starvedSeeds} of ${FAIRNESS_SEEDS}\\*\\* seeds`));
    });

    it("docs/FAIRNESS.md quotes the same measured count — in both places", () => {
      // FAIRNESS.md was checked by nothing at all; it states the figure twice,
      // in a table and in prose, and both are asserted here.
      expect(fairnessDoc, "the results table").toMatch(
        new RegExp(`\\*\\*${starvedSeeds} / ${FAIRNESS_SEEDS}\\*\\*`),
      );
      expect(fairnessDoc, "the prose restatement").toMatch(
        new RegExp(`${starvedSeeds} of\\s*\\n?${FAIRNESS_SEEDS}\\s*seeds`),
      );
    });

    it(`no OTHER 'N of ${FAIRNESS_SEEDS}' figure is lying around the docs`, () => {
      // The negative half, BUILT FROM the computed values rather than written
      // beside them — the precise mistake that let a stale 202 sit green for
      // four days in this workspace. Both legitimate counts are run: the FIFO
      // control arm's, and the capped policy's (structurally zero).
      const legitimate = new Set([String(starvedSeeds), String(cappedStarvation())]);
      const stale = [
        ...(readme + "\n" + fairnessDoc).matchAll(
          new RegExp(`\\b(\\d+)\\s*(?:of|/)\\s*${FAIRNESS_SEEDS}\\b`, "g"),
        ),
      ]
        .map((m) => m[0])
        .filter((m) => !legitimate.has(/^\d+/.exec(m)?.[0] ?? ""));
      expect(stale, "a starvation figure that no run produces").toEqual([]);
    });
  });

  describe("the findings sentence is counted from LEDGER.md, not remembered", () => {
    // The README once said "three of the eight" under a table with nine rows.
    // The portfolio and the resume both quote this sentence, so it is asserted
    // against the ledger's summary table — the same rows the portfolio's daily
    // claim-check counts.
    const ledger = readFileSync(join(root, "docs", "LEDGER.md"), "utf8");
    const ledgerRows = ledger
      .split("\n")
      .filter((line) => /^\| L\d+ /.test(line))
      .map((line) => {
        const cells = line.split("|").map((c) => c.trim());
        // | # | Found by | Severity | What |
        return { id: cells[1] ?? "", foundBy: cells[2] ?? "", severity: cells[3] ?? "" };
      });
    // A finding is "in the checking apparatus" when its severity names the
    // checker, the reference oracle or the harness rather than the system.
    const apparatus = ledgerRows.filter((r) =>
      /checker|reference|harness/i.test(r.severity),
    );

    // Spelled out up to thirty. The list used to stop at twelve, so the moment
    // the ledger grew past it this check read NaN — fail-loud, but for the
    // wrong reason, which costs the next reader the same ten minutes.
    const WORDS: readonly string[] = [
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
    ];
    const toNumber = (w: string): number => {
      const idx = WORDS.indexOf(w.toLowerCase());
      return idx >= 0 ? idx : Number(w);
    };

    // `[\w-]+`, not `\w+`: the count crossed twenty and became "twenty-one",
    // which `\w` cannot span. The guard then matched nothing and reported
    // `expected null not to be null` — fail-loud, but naming the wrong thing.
    //
    // MATCHED AGAINST WHITESPACE-COLLAPSED PROSE. The regex used to run against
    // the raw file, so whether it matched depended on where the sentence
    // happened to WRAP — add a word earlier in the paragraph and this guard
    // reports `expected null not to be null`, which names neither the real
    // problem nor the file. Fail-loud is not enough on its own; it has to fail
    // for the reason it exists.
    const flat = readme.replace(/\s+/g, " ");
    const sentence =
      /([\w-]+) of the ([\w-]+) were in the \*\*checker, the reference oracle or the harness\*\*[^.]*\./.exec(
        flat,
      );

    it("the ledger table has at least one row and one apparatus finding", () => {
      expect(ledgerRows.length).toBeGreaterThan(0);
      expect(apparatus.length).toBeGreaterThan(0);
    });

    it("the README's 'N of the M' matches the ledger's row count and apparatus count", () => {
      expect(
        sentence,
        "README must state how many findings were in the apparatus",
      ).not.toBeNull();
      const [, inApparatus = "", total = ""] = sentence!;
      expect(
        toNumber(total),
        `README says ${total} findings; LEDGER.md's table has ${ledgerRows.length} rows`,
      ).toBe(ledgerRows.length);
      expect(
        toNumber(inApparatus),
        `README says ${inApparatus} were in the apparatus; LEDGER.md marks ` +
          `${apparatus.length} (${apparatus.map((r) => r.id).join(", ")})`,
      ).toBe(apparatus.length);
    });

    it("the sentence names exactly the ledger rows marked checker/reference/harness", () => {
      expect(sentence).not.toBeNull();
      const named = [...sentence![0].matchAll(/\bL(\d+)\b/g)]
        .map((m) => `L${m[1]}`)
        .sort();
      expect(named).toEqual(apparatus.map((r) => r.id).sort());
    });

    it("the README table has one row per ledger row", () => {
      const readmeRows = readme
        .split("\n")
        .filter((line) => /^\| \*\*L\d+\*\* /.test(line));
      expect(readmeRows.length, "README table rows vs LEDGER table rows").toBe(
        ledgerRows.length,
      );
    });

    it("every ledger table row has a write-up section", () => {
      // L4, L5 and L6 sat in the table for weeks with no section under it.
      const missing = ledgerRows
        .map((r) => r.id)
        .filter((id) => !new RegExp(`^## ${id} `, "m").test(ledger));
      expect(missing, "ledger rows with no `## Lx ·` write-up").toEqual([]);
    });
  });

  /**
   * THE README PUBLISHES THREE HASHES AND NOTHING REPRODUCED THEM.
   *
   * "See it work" shows `simulate --seed 4711 --hash-only` printing a specific
   * digest and says "the hashes are the ones you will get". They were written
   * once, by hand, and checked by no test — the exact shape this file exists to
   * forbid, sitting in the one section a reader is most likely to run.
   *
   * It is also the gap that made the determinism suite weaker than it reads.
   * That suite asserts the same seed hashes the same twice, across processes,
   * and that different seeds differ. All three properties hold for a WRONG
   * generator: a mutated PRNG is still perfectly deterministic and still
   * perfectly distinct. Nothing anywhere pinned an actual value, so nothing
   * could tell a correct spine from a changed one.
   */
  describe("the hashes the README prints are the hashes the code produces", () => {
    const quoted = [
      ...readme.matchAll(/simulate --seed (\d+) --hash-only\n([0-9a-f]{64})/g),
    ].map((m) => ({ seed: Number(m[1]), hash: m[2] as string }));

    it("the README actually quotes some — a parse that finds none proves nothing", () => {
      expect(quoted.length, "README must show reproducible hash output").toBeGreaterThan(
        1,
      );
    });

    it("every quoted hash is the one the simulation produces", () => {
      const wrong = quoted
        .map(({ seed, hash }) => ({
          seed,
          quoted: hash,
          actual: runSimulation(
            { ...DEFAULT_CONFIG, seed },
            new NaivePolicy(4),
          ).log.hash(),
        }))
        .filter((r) => r.quoted !== r.actual);
      expect(wrong, "README hashes that no run reproduces").toEqual([]);
    });

    it("different seeds in the README really do print different hashes", () => {
      // Otherwise the block could be satisfied by a spine that ignores the seed.
      const distinct = new Set(quoted.map((q) => q.hash));
      const seeds = new Set(quoted.map((q) => q.seed));
      expect(distinct.size).toBe(seeds.size);
    });
  });

  it("claims zero runtime dependencies, and has zero", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(readme).toContain("Zero runtime dependencies");
    expect(Object.keys(pkg.dependencies ?? {}), "runtime dependencies").toEqual([]);
  });

  it("names its prior art — the techniques are not presented as original", () => {
    // A project that reimplements published work and does not say so gets found
    // out in the first follow-up question.
    for (const name of ["FoundationDB", "Zeller", "Kleppmann", "Pub/Sub API"]) {
      expect(readme, `README must credit ${name}`).toContain(name);
    }
  });

  it("states what the oracles CANNOT do", () => {
    // The blind spots are load-bearing: an interviewer who finds one the README
    // did not mention concludes the author did not know.
    expect(readme).toContain("blind to a shared misunderstanding");
    expect(readme).toContain("blind to a wrong identity");
    expect(readme).toContain("no reaper");
  });
});
