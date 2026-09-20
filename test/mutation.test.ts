import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

import {
  MUTATED_SCOPES,
  UNMUTATED_SCOPES,
  gradedSuite,
  reachesMutatedCode,
} from "../scripts/mutationScope.mjs";

/**
 * THE MUTATION HARNESS'S OWN GUARDS.
 *
 * Every layer that grades another needs someone grading it, and this project
 * has three findings in this one file's lineage: L7 (the harness reported 100%
 * because the suite was already red), L9 (the negation operator did not negate)
 * and L19 (three mutants that did not parse were scored as kills). All three
 * inflated the number in the direction that looked like success.
 *
 * Two things are asserted here because both are new and both could rot
 * silently: which SOURCE is mutated, and which TESTS a mutant is graded
 * against.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const graded = gradedSuite();

describe("what gets mutated", () => {
  it("covers the oracles and the core, not just the policy", () => {
    // The exclusion that used to exist was exactly backwards: more than half of
    // this project's findings were in the checker, the reference oracle or the
    // harness, and that was the one layer nothing was allowed to mutate.
    expect([...MUTATED_SCOPES].sort()).toEqual(["core", "oracle", "policy"]);
  });

  it("every mutated scope is a directory that exists and has source in it", () => {
    for (const scope of MUTATED_SCOPES) {
      const files = readdirSync(join(root, "src", scope)).filter((f) =>
        f.endsWith(".ts"),
      );
      expect(files.length, `src/${scope} has no source to mutate`).toBeGreaterThan(0);
    }
  });

  it("every src/ directory is either mutated or explicitly excused", () => {
    // A new directory must not be able to appear and quietly go unmutated —
    // that is how `src/policy` came to be the only scope in the first place.
    const dirs = readdirSync(join(root, "src"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const accounted = new Set([...MUTATED_SCOPES, ...UNMUTATED_SCOPES]);
    expect(
      dirs.filter((d) => !accounted.has(d)),
      "src/ directories that are neither mutated nor listed as excused",
    ).toEqual([]);
  });

  it("MUTATION.md states why the excused directories are excused", () => {
    const doc = readFileSync(join(root, "docs", "MUTATION.md"), "utf8");
    for (const scope of UNMUTATED_SCOPES) {
      expect(doc, `MUTATION.md must account for src/${scope}`).toContain(`src/${scope}`);
    }
  });
});

describe("what the mutants are graded against", () => {
  it("the graded set is not empty and not everything", () => {
    // Both failure modes are silent. An empty graded set scores every mutant
    // as a survivor; grading against everything costs hours of suites that
    // cannot observe the mutation.
    expect(graded.graded.length).toBeGreaterThan(10);
    expect(graded.skipped.length).toBeGreaterThan(0);
  });

  it("no SKIPPED file can reach the mutated code, transitively", () => {
    // The soundness half. Skipping a file that could kill a mutant makes the
    // score under-read, and a survivor that is not really a survivor sends the
    // next reader hunting for a gap that is not there.
    const unsound = graded.skipped.filter((f) => reachesMutatedCode(f));
    expect(unsound.map((f) => relative(root, f))).toEqual([]);
  });

  it("every GRADED file really does reach the mutated code", () => {
    const useless = graded.graded.filter((f) => !reachesMutatedCode(f));
    expect(useless.map((f) => relative(root, f))).toEqual([]);
  });

  it("the walk follows imports transitively, not just direct ones", () => {
    // `fairness.test.ts` imports no src/ module directly — it goes through
    // `test/support/fairnessHarness.ts`. If the walk were one level deep it
    // would be excluded, and mutants it could kill would read as survivors.
    const fairness = join(root, "test", "fairness.test.ts");
    expect(readFileSync(fairness, "utf8")).not.toMatch(/from "\.\.\/src\//);
    expect(
      reachesMutatedCode(fairness),
      "a transitive import must count as reaching the mutated code",
    ).toBe(true);
  });

  it("the walk says NO for a file that genuinely imports nothing local", () => {
    // The walker's own non-vacuity: a function that answers `true` for
    // everything would pass every assertion above.
    const standalone = join(root, "test", "checkNoSecretFiles.test.ts");
    expect(reachesMutatedCode(standalone)).toBe(false);
  });
});

describe("the harness refuses to report a meaningless number", () => {
  const src = readFileSync(join(root, "scripts", "mutate.mjs"), "utf8");

  it("still refuses to run against an already-red suite (L7)", () => {
    expect(src).toContain("REFUSING TO RUN");
    expect(src).toMatch(/baseline\.verdict !== "pass"/);
  });

  it("excludes mutants that do not parse rather than scoring them killed (L19)", () => {
    expect(src).toContain("esbuild.transformSync");
    expect(src).toMatch(/const mutants = generated\.filter/);
  });

  it("grades cheapest-first and stops at the first failure", () => {
    // A mutant is killed the moment any graded file fails, so the rest could
    // only agree. Without bail the campaign runs every reachable file for every
    // mutant — hours of suites whose verdict is already decided.
    expect(src, "the run must bail at the first failing file").toContain("--bail=1");
    expect(src, "bail is meaningless if files run in parallel").toContain(
      "--no-file-parallelism",
    );
    expect(src, "the order must come from a measurement, not a list").toMatch(
      /parseFileCosts/,
    );
  });

  it("does not count a TIMEOUT as a kill", () => {
    // New in this round, and the same class as L7 and L19: the suite grew
    // heavy enough that process-spawning tests began timing out under load,
    // and every one of those would have been scored as a kill. A mutant killed
    // by a stopwatch measures nothing about the suite.
    expect(src).toMatch(/verdict: "timeout"/);
    expect(src, "a timed-out run must be retried before being written off").toMatch(
      /if \(verdict === "timeout"\) verdict = judge\(/,
    );
    expect(src, "inconclusive mutants must leave the denominator").toMatch(
      /selected\.length - inconclusive\.length/,
    );
  });
});

describe("an interrupted campaign cannot be silent", () => {
  /**
   * The harness edits `src/` in place and restores it after each mutant. Kill it
   * between those two writes and a one-line mutation is left in the working
   * tree, indistinguishable from code somebody meant to write.
   *
   * That is not hypothetical: it happened while this round's campaign was being
   * tuned, leaving `if (!(window !== this.creditsWindow))` in `debit()`. It was
   * caught by grepping the diff for operator artefacts, which is exactly the
   * kind of catch that works once and then does not.
   */
  it("no mutation campaign is mid-flight in this working tree", () => {
    const marker = join(root, ".mutation-in-progress");
    expect(
      existsSync(marker),
      "scripts/mutate.mjs left its marker behind — a mutant may still be " +
        "planted in src/. Restore the working tree, then delete the marker.",
    ).toBe(false);
  });

  it("the harness writes and clears that marker, and traps signals", () => {
    const src = readFileSync(join(root, "scripts", "mutate.mjs"), "utf8");
    expect(src).toContain(".mutation-in-progress");
    expect(src, "^C must restore the source before exiting").toMatch(
      /process\.on\("SIGINT"/,
    );
    expect(src).toMatch(/process\.on\("SIGTERM"/);
  });
});

describe("triage notes cannot outlive the code they argue about", () => {
  /**
   * A survivor that is EQUIVALENT or ACCEPTABLE gets an argument, keyed by the
   * source line it mutates. Delete or rewrite that line and the argument is
   * still sitting there, addressed to nothing — and the next reader has no way
   * to tell a live justification from an obsolete one.
   *
   * That already happened in this round: removing `creditsExpected()` orphaned
   * the note about `run.status === "cancelled" && run.slotId === null`. It was
   * caught by eye, which is not a method.
   */
  const harness = readFileSync(join(root, "scripts", "mutate.mjs"), "utf8");

  function triageKeys(): Array<{ file: string; op: string; line: string }> {
    const block = /const TRIAGE = \{([\s\S]*?)\n\};/.exec(harness);
    expect(block, "mutate.mjs must define a TRIAGE map").not.toBeNull();
    return [
      ...(block?.[1] ?? "").matchAll(/^\s*["']([^"']+\.ts)\|([^|]+)\|(.+?)["']:/gm),
    ].map((m) => ({ file: m[1] as string, op: m[2] as string, line: m[3] as string }));
  }

  it("finds the triage entries at all — a parse that matches nothing proves nothing", () => {
    expect(triageKeys().length).toBeGreaterThan(5);
  });

  it("every triage entry names a line that still exists in that file", () => {
    const orphans = triageKeys().filter(({ file, line }) => {
      const src = readFileSync(join(root, file), "utf8");
      // The key stores the line TRIMMED and truncated to 90 chars, so compare
      // against each trimmed source line by prefix rather than by equality.
      return !src
        .split("\n")
        .some((l) => l.trim().startsWith(line.slice(0, 60).replace(/\\"/g, '"')));
    });
    expect(
      orphans.map((o) => `${o.file}|${o.op}|${o.line.slice(0, 50)}`),
      "triage arguments addressed to code that no longer exists",
    ).toEqual([]);
  });
});
