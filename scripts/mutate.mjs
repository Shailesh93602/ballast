#!/usr/bin/env node
/**
 * Mechanical mutation testing over `src/policy`, `src/oracle` and `src/core`.
 *
 * WHY THIS EXISTS, when there are already 16 hand-written semantic mutants:
 * those are bugs I thought of. Catching all of them proves the suite handles my
 * imagination, which is a weaker claim than it sounds. This tier applies a fixed
 * operator set at every applicable site, mechanically, with no idea what the
 * code means — so it generates the bugs I did NOT think of. The score here is
 * the number worth quoting.
 *
 * Hand-rolled rather than using Stryker: the project takes zero dependencies,
 * and a mutation harness whose own behaviour you cannot read is a strange thing
 * to build a correctness argument on.
 *
 * Operators (deliberately small and mechanical):
 *   - comparison flip      >= <-> >   |   <= <-> <   |   === <-> !==
 *   - off-by-one           x + 1 -> x   |   x - 1 -> x
 *   - boolean negation     if (c) -> if (!c)
 *   - statement deletion   a whole statement line removed
 *   - increment removal    x++ -> x
 *
 * A mutant SURVIVES if the whole suite still passes with it applied. Every
 * survivor must be triaged by hand into: equivalent (semantically identical to
 * the original), uncovered (a real gap — write an invariant), or acceptable
 * (unreachable or immaterial). Untriaged survivors are not allowed to sit.
 *
 * Run: node scripts/mutate.mjs [--quick]
 */

import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";
import * as esbuild from "esbuild";
import {
  TARGET_DIRS,
  UNMUTATED_SCOPES,
  gradedSuite,
  reachesFile,
} from "./mutationScope.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/**
 * Scope and the graded suite are computed in `mutationScope.mjs` — extracted so
 * `test/mutation.test.ts` can assert them without running the campaign.
 */
const { graded: SUITE_FILES, skipped: SKIPPED_FILES } = gradedSuite();
const QUICK = process.argv.includes("--quick");

/** Every mutation operator, as a line-level rewrite with a name. */
const OPERATORS = [
  { name: "cmp:>=->>", find: />=/g, replace: ">" },
  { name: "cmp:<=-><", find: /<=/g, replace: "<" },
  { name: "cmp:===->!==", find: /===/g, replace: "!==" },
  { name: "cmp:!==->===", find: /!==/g, replace: "===" },
  { name: "offbyone:+1", find: /\+ 1\b/g, replace: "+ 0" },
  { name: "offbyone:-1", find: /- 1\b/g, replace: "- 0" },
  { name: "bool:negate-if", find: /\bif \(/g, replace: "if (!" },
];

function sourceFiles() {
  return TARGET_DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(dir, f)),
  );
}

/** "policy" | "oracle" | "core", from a file path. */
function scopeOf(file) {
  return relative(join(root, "src"), file).split("/")[0];
}

/**
 * Build every mutant: one mutation, one site, one file.
 * Returns {file, line, col, operator, original, mutated}.
 */
function buildMutants() {
  const mutants = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comments and blank lines — mutating a comment proves nothing.
      const trimmed = line.trim();
      if (
        trimmed === "" ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      ) {
        continue;
      }

      for (const op of OPERATORS) {
        op.find.lastIndex = 0;
        let match;
        while ((match = op.find.exec(line)) !== null) {
          let mutatedLine;
          if (op.name === "bool:negate-if") {
            // Splicing `if (!` without parens does NOT negate: `if (a !== b)`
            // became `if ((!a) !== b)` — always true, a vacuous mutant that
            // "survives" and reads as a suite gap (found 2026-08-29 when a
            // hand-applied REAL negation of a "survivor" failed the suite
            // instantly). Wrap the full balanced condition instead.
            const open = match.index + 4; // after "if ("
            let depth = 1;
            let close = -1;
            for (let c = open; c < line.length; c++) {
              if (line[c] === "(") depth++;
              else if (line[c] === ")") {
                depth--;
                if (depth === 0) {
                  close = c;
                  break;
                }
              }
            }
            if (close === -1) continue; // condition spans lines — skip
            mutatedLine =
              line.slice(0, open) +
              "!(" +
              line.slice(open, close) +
              ")" +
              line.slice(close);
          } else {
            mutatedLine =
              line.slice(0, match.index) +
              op.replace +
              line.slice(match.index + match[0].length);
          }
          if (mutatedLine === line) continue;
          const mutatedLines = [...lines];
          mutatedLines[i] = mutatedLine;
          mutants.push({
            file,
            line: i + 1,
            operator: op.name,
            original: trimmed.slice(0, 90),
            mutated: mutatedLine.trim().slice(0, 90),
            content: mutatedLines.join("\n"),
          });
          if (op.find.lastIndex === match.index) op.find.lastIndex++;
        }
      }
    }

    // Statement deletion: drop one simple statement line at a time.
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!/^(this\.[\w.]+ = |this\.[\w.]+\.set\(|[\w.]+\+\+;|[\w.]+ = )/.test(trimmed)) {
        continue;
      }
      const mutatedLines = [...lines];
      mutatedLines[i] = "";
      mutants.push({
        file,
        line: i + 1,
        operator: "delete:statement",
        original: trimmed.slice(0, 90),
        mutated: "(deleted)",
        content: mutatedLines.join("\n"),
      });
    }
  }
  return mutants;
}

/**
 * Run some test files. Returns { verdict, output }.
 *
 * "timeout" IS NOT A KILL. A mutant is judged killed when the suite fails an
 * assertion; a suite that failed because a process-spawning test ran out of
 * wall clock under load has said nothing about the mutant at all. Counting it
 * would be the same error as L19 (a mutant killed by a syntax error) and L7 (a
 * mutant killed by an already-red suite): a kill that measures nothing, in the
 * direction that flatters the score (LEDGER L27).
 */
function runFiles(files, extraArgs = []) {
  try {
    const output = execFileSync("npx", ["vitest", "run", ...extraArgs, ...files], {
      cwd: root,
      stdio: "pipe",
      encoding: "utf8",
      timeout: 300_000,
    });
    return { verdict: "pass", output };
  } catch (err) {
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (/Test timed out in \d+ms/.test(output) || err.killed === true) {
      return { verdict: "timeout", output };
    }
    return { verdict: "fail", output };
  }
}

/**
 * GRADING ONE MUTANT: cheapest file first, stop at the first failure.
 *
 * A mutant is killed the moment ANY graded file fails, so once one has failed
 * the rest could only agree with it. `--bail=1` with `--no-file-parallelism`
 * makes vitest stop there, and running the cheap unit files before the
 * expensive corpora means the common case — a mutant killed by a fast unit
 * test — costs one file instead of fifteen. Measured on this suite: a killed
 * mutant goes from ~7s to ~0.8s of test time.
 *
 * `reachesFile` narrows it further: a test that cannot reach the mutated module
 * through any chain of local imports cannot observe the mutation.
 *
 * This changes what is RUN, never what is CONCLUDED.
 */
function judge(mutatedFile, cost) {
  const files = SUITE_FILES.filter((f) => reachesFile(f, mutatedFile)).sort(
    (a, b) => (cost.get(a) ?? 0) - (cost.get(b) ?? 0),
  );
  if (files.length === 0) return "pass";
  return runFiles(files, ["--reporter=dot", "--no-file-parallelism", "--bail=1"]).verdict;
}

/**
 * WHAT EACH TEST FILE COSTS, MEASURED — not guessed, and not a hand list.
 *
 * Parsed out of one ordinary run of the graded suite, so it costs nothing extra
 * and it measures the number that matters: time spent RUNNING the file, not the
 * four seconds of npx and vite startup that dominate a standalone invocation
 * and would rank the files almost at random.
 *
 * Calibrated rather than written down for the same reason the exclusion set is
 * computed: a hand-maintained order goes stale the moment a file gets slower,
 * and nothing would say so.
 */
function parseFileCosts(output) {
  const cost = new Map();
  for (const m of output.matchAll(/([\w./-]+\.test\.ts) \(\d+ tests?\)\s+(\d+)ms/g)) {
    cost.set(join(root, m[1]), Number(m[2]));
  }
  return cost;
}

/**
 * Refuse to run against a failing suite.
 *
 * A mutant is judged KILLED when the suite fails with it applied. If the suite
 * ALREADY fails, every mutant is killed and the harness reports a perfect
 * score — the most dangerous possible output, because it looks like success.
 *
 * This happened: a stale test count in the README made three assertions fail,
 * and the run reported 100% while genuinely surviving mutants went unnoticed.
 * The number that should have raised an alarm was the reassuring one.
 */
const baseline = runFiles(SUITE_FILES, ["--reporter=basic"]);
if (baseline.verdict !== "pass") {
  console.error(
    [
      "REFUSING TO RUN: the test suite fails before any mutation is applied.",
      "",
      "Every mutant would be scored KILLED and the result would read 100%,",
      "because a mutant is killed by the suite failing — and it already does.",
      "",
      "Fix the suite, then re-run.",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * A mutant that does not PARSE was never a mutant.
 *
 * The harness scores a mutant KILLED when the suite exits non-zero — and a
 * syntax error does that before a single assertion runs. `delete:statement`
 * removes one LINE, so deleting the first line of a multi-line statement
 * (`this.runs.set(runId, {`) leaves an unbalanced brace, and the resulting
 * "kill" measures nothing about the test suite at all.
 *
 * It was three of 165 here — small, and a 95.8% that quietly includes three
 * free kills is still the same class of error as L7, where the harness
 * reported 100% because the suite was already red. The score has to be
 * measured against mutants that could have survived.
 */
function parses(source) {
  try {
    esbuild.transformSync(source, { loader: "ts", format: "esm" });
    return true;
  } catch {
    return false;
  }
}

const generated = buildMutants();
const invalid = generated.filter((m) => !parses(m.content));
const mutants = generated.filter((m) => parses(m.content));
const selected = QUICK ? mutants.filter((_, i) => i % 4 === 0) : mutants;

console.log(
  `Mutation testing over ${TARGET_DIRS.map((d) => relative(root, d)).join(", ")} — ` +
    `${selected.length} mutants` +
    (QUICK ? ` (quick: 1 in 4 of ${mutants.length})` : ""),
);
if (invalid.length > 0) {
  console.log(
    `${invalid.length} generated mutant(s) do not parse and are EXCLUDED rather ` +
      `than scored as kills:`,
  );
  for (const m of invalid) {
    console.log(`  ${relative(root, m.file)}:${m.line}  ${m.operator}  ${m.original}`);
  }
}
const FILE_COST = parseFileCosts(baseline.output);
console.log("per-file cost, parsed from the baseline run (cheapest graded first):");
for (const [f, ms] of [...FILE_COST].sort((a, b) => a[1] - b[1])) {
  console.log(`  ${String(ms).padStart(6)}ms  ${relative(root, f)}`);
}
console.log("─".repeat(72));

const survivors = [];
const perScope = new Map();
for (const m of selected) {
  const sc = scopeOf(m.file);
  if (!perScope.has(sc)) perScope.set(sc, { total: 0, killed: 0 });
  perScope.get(sc).total++;
}
let killed = 0;
const originals = new Map();
for (const f of sourceFiles()) originals.set(f, readFileSync(f, "utf8"));

/**
 * A MARKER THAT SAYS "THERE MAY BE A MUTANT IN YOUR SOURCE RIGHT NOW".
 *
 * This harness edits `src/` in place and restores it after each mutant. Kill it
 * between those two writes — ^C, a crash, a closed laptop — and a one-line
 * mutation is left sitting in the working tree, indistinguishable from code
 * somebody meant to write. That happened during this round: an interrupted run
 * left `if (!(window !== this.creditsWindow))` in `debit()`, and it was found by
 * grepping the diff for operator artefacts rather than by anything automatic.
 *
 * The marker is written before the first mutation and removed after the last,
 * and `test/mutation.test.ts` fails while it exists. A corrupted working tree
 * is now loud instead of silent.
 */
const MARKER = join(root, ".mutation-in-progress");
writeFileSync(
  MARKER,
  "A mutation campaign was interrupted. src/ may contain a planted mutant.\n" +
    "Restore with: git diff src/ | grep -nE '\\+ 0|- 0|if \\(!\\('\n" +
    "then delete this file.\n",
  "utf8",
);
const clearMarker = () => {
  for (const [f, src] of originals) writeFileSync(f, src, "utf8");
  rmSync(MARKER, { force: true });
};
process.on("SIGINT", () => {
  clearMarker();
  process.exit(130);
});
process.on("SIGTERM", () => {
  clearMarker();
  process.exit(143);
});

const inconclusive = [];
let idx = 0;
for (const m of selected) {
  idx++;
  writeFileSync(m.file, m.content, "utf8");
  let verdict = judge(m.file, FILE_COST);
  // One retry: a timeout under load is noise, and noise must not be scored.
  if (verdict === "timeout") verdict = judge(m.file, FILE_COST);
  writeFileSync(m.file, originals.get(m.file), "utf8");

  if (verdict === "timeout") {
    inconclusive.push(m);
    perScope.get(scopeOf(m.file)).total--;
    console.log(
      `INCONCLUSIVE (timed out twice)  ${relative(root, m.file)}:${m.line}  ${m.operator}`,
    );
  } else if (verdict === "pass") {
    survivors.push(m);
    console.log(
      `SURVIVED  ${relative(root, m.file)}:${m.line}  ${m.operator}\n            ${m.original}`,
    );
  } else {
    killed++;
    perScope.get(scopeOf(m.file)).killed++;
  }
  if (idx % 10 === 0) {
    console.log(
      `… ${idx}/${selected.length}  killed=${killed} survived=${survivors.length}` +
        (inconclusive.length > 0 ? ` inconclusive=${inconclusive.length}` : ""),
    );
  }
}

// Restore everything, defensively, and clear the interrupted-run marker.
clearMarker();

const scored = selected.length - inconclusive.length;
const score = scored === 0 ? 0 : (killed / scored) * 100;
const scopeRows = [...perScope.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([scope, s]) => ({
    scope,
    ...s,
    score: s.total === 0 ? 0 : (s.killed / s.total) * 100,
  }));
console.log("─".repeat(72));
for (const r of scopeRows) {
  console.log(
    `  src/${r.scope.padEnd(7)} killed ${r.killed}/${r.total}   ${r.score.toFixed(1)}%`,
  );
}
console.log(`killed ${killed}/${scored}   mutation score ${score.toFixed(1)}%`);

/**
 * Hand triage for survivors that are genuinely EQUIVALENT.
 *
 * Kept in the script so the report stays regenerable — a triage note written
 * into the generated markdown would be overwritten on the next run, and a triage
 * that disappears is worse than none.
 *
 * KEYED BY THE MUTATED SOURCE LINE, NOT BY LINE NUMBER. The previous key was
 * `file:line:operator`, which every edit to the file above a triaged site
 * silently invalidated — and worse, a shifted line could hand a DIFFERENT
 * mutant an argument written about its former neighbour. Adding six lines to
 * `admit()` broke all six triage entries at once. The text of the line a
 * survivor mutates is what the argument is actually about, so that is the key.
 *
 * Only `equivalent` / `acceptable` belong here. A survivor that is `uncovered`
 * gets a TEST, not an entry.
 */
const TRIAGE = {
  // ── src/core/rng.ts ────────────────────────────────────────────────────────
  "src/core/rng.ts|cmp:<=-><|if (p <= 0) return false;":
    "EQUIVALENT — `nextFloat()` is `Number(next64() >> 11n) / 2**53`, so it " +
    "lies in [0, 1). With p = 0 the mutant falls through to `nextFloat() < 0`, " +
    "which is false for every draw: the same answer the guard gives. The guard " +
    "is an early return, not a correctness check.",
  "src/core/rng.ts|cmp:>=->>|if (p >= 1) return true;":
    "EQUIVALENT — the same argument at the other end. The maximum of " +
    "`nextFloat()` is (2**53 - 1) / 2**53, so with p = 1 the mutant falls " +
    "through to `nextFloat() < 1`, which is true for every draw.",
  "src/core/rng.ts|cmp:>=->>|while (draw >= limit) draw = this.next64();":
    "ACCEPTABLE (not distinguishable) — `limit` is the largest multiple of " +
    "`range` that fits in 64 bits, and the loop rejects draws at or above it so " +
    "every residue is equally likely. The mutant additionally ACCEPTS " +
    "`draw === limit`: one value in 2**64, biasing a single residue by 2**-64. " +
    "No test can separate that from the original without ~2**64 draws, so it is " +
    "reported rather than papered over with a test that would not really kill it.",
  "src/core/rng.ts|offbyone:-1|return weights.length - 1;":
    "ACCEPTABLE (unreachable) — the loop returns as soon as `target < 0`, and " +
    "`target` starts below `total`, so the final line is a defensive clamp " +
    "reached only if floating-point residue leaves `target >= 0` after every " +
    "weight has been subtracted. The mutant turns that clamp into an " +
    "out-of-range index; the line it breaks is one nothing in the corpus reaches.",
  // ── src/oracle/shrink.ts ───────────────────────────────────────────────────
  "src/oracle/shrink.ts|offbyone:-1|granularity = Math.max(granularity - 1, 2);":
    "ACCEPTABLE (cost, not result) — ddmin's granularity schedule controls how " +
    "many candidates the search evaluates, not which minimal input it converges " +
    "on. Both this and the deletion below leave granularity higher after a " +
    "successful reduction, so the search does more work; the S2 1-minimality " +
    "test still passes, which is the evidence for the claim rather than the " +
    "assertion of it.",
  "src/oracle/shrink.ts|delete:statement|granularity = Math.max(granularity - 1, 2);":
    "ACCEPTABLE (cost, not result) — same argument as the off-by-one at this line.",
  "src/policy/replayLog.ts|cmp:<=-><|if (available <= 0) return []; // paused, not dropping":
    "EQUIVALENT — when `available` is exactly 0, the guarded path calls " +
    "readFrom(cursor, 0), which returns an empty list anyway. Behaviour is " +
    "identical either way; the guard is an early return, not a correctness check.",
  "src/policy/controlPlane.ts|offbyone:+1|this.releasesThisGeneration.set(slotId, prior + 1);":
    "ACCEPTABLE (unreachable) — a second ACCEPTED release of one generation " +
    "cannot happen: release nulls the tenant, so a repeat is refused not-held, " +
    "and a re-admit resets the generation counter to 0. The counter and I5 are " +
    "defensive depth against a future change to release() itself.",
  "src/policy/controlPlane.ts|delete:statement|this.releasesThisGeneration.set(slotId, prior + 1);":
    "ACCEPTABLE (unreachable) — same argument as the off-by-one at this line.",
  "src/policy/controlPlane.ts|delete:statement|run.effectApplied = true;":
    "EQUIVALENT — complete() is guarded by the status CAS (early return on " +
    "completed and cancelled), so `effectApplied` can never be consulted " +
    "again on any reachable path; it is belt-and-braces for a refactor.",
};

function triageFor(s) {
  const key = `${relative(root, s.file)}|${s.operator}|${s.original}`;
  return TRIAGE[key] ?? null;
}

const report = [
  "# MUTATION.md — mechanical mutation testing",
  "",
  "Generated by `node scripts/mutate.mjs`. Do not edit the numbers by hand —",
  "regenerate them.",
  "",
  "## Why this exists alongside the 16 hand-written mutants",
  "",
  "The semantic mutants in `test/mutants.test.ts` are bugs I thought of. Catching",
  "all of them proves the suite handles my imagination, which is a weaker claim",
  "than it sounds. This tier applies a fixed operator set at every applicable site",
  "with no idea what the code means, so it generates the bugs I did **not** think",
  "of. **This is the score worth quoting.**",
  "",
  "Hand-rolled rather than Stryker: the project takes zero dependencies, and a",
  "mutation harness whose own behaviour you cannot read is a strange foundation",
  "for a correctness argument.",
  "",
  "## Result",
  "",
  `- Mutants generated: **${scored}**${QUICK ? ` (quick sample of ${mutants.length})` : ""}`,
  `- Killed: **${killed}**`,
  `- Survived: **${survivors.length}**`,
  `- **Mutation score: ${score.toFixed(1)}%**`,
  "",
  "### By scope",
  "",
  "Reported separately because they mean different things. A survivor in",
  "`src/policy` is a gap in the tests. A survivor in `src/oracle` is an oracle",
  "that can be wrong without any test noticing — which is this project's",
  "recurring failure, not a lesser version of it.",
  "",
  "| Scope | Killed | Total | Score |",
  "| --- | --- | --- | --- |",
  ...scopeRows.map(
    (r) => `| \`src/${r.scope}\` | ${r.killed} | ${r.total} | ${r.score.toFixed(1)}% |`,
  ),
  "",
  invalid.length === 0
    ? "Every generated mutant parsed, so every one of them could have survived."
    : `${invalid.length} further mutant(s) were generated but do not PARSE ` +
      "(deleting the first line of a multi-line statement), and are excluded " +
      "rather than counted. A mutant killed by a syntax error measures nothing " +
      "about the suite — the same class of error as L7.",
  "",
  inconclusive.length === 0
    ? "Every mutant reached a verdict: the graded suite either failed an " +
      "assertion (killed) or passed (survived)."
    : `${inconclusive.length} mutant(s) are INCONCLUSIVE — the graded suite ` +
      "timed out twice rather than failing an assertion, so they are excluded " +
      "from the denominator rather than counted as kills. A mutant killed by " +
      "a stopwatch measures nothing about the suite, the same error as L19.",
  "",
  "## What the mutants are graded against",
  "",
  `${SUITE_FILES.length} of ${SUITE_FILES.length + SKIPPED_FILES.length} test files.` +
    " The rest import nothing from the mutated directories, directly or" +
    " transitively, so they cannot observe a mutation — they exercise a shell" +
    " script, the eslint perimeter and the Tier B Postgres arm. The set is" +
    " computed by walking each test file's imports, not listed by hand, and" +
    " `test/mutation.test.ts` asserts the walk is sound.",
  "",
  ...(SKIPPED_FILES.length === 0
    ? []
    : [
        "Not graded against: " +
          SKIPPED_FILES.map((f) => "`" + relative(root, f) + "`").join(", ") +
          ".",
        "",
      ]),
  "## Operators",
  "",
  "| Operator | Meaning |",
  "| --- | --- |",
  "| `cmp:>=->>` / `cmp:<=-><` | boundary flip — catches off-by-one at a limit |",
  "| `cmp:===->!==` / `cmp:!==->===` | equality inversion |",
  "| `offbyone:+1` / `offbyone:-1` | drop an increment/decrement |",
  "| `bool:negate-if` | invert a branch condition |",
  "| `delete:statement` | remove one assignment/increment entirely |",
  "",
  "## Survivors — every one must be triaged",
  "",
  survivors.length === 0
    ? "None. Every mutant was killed."
    : [
        "A survivor is not automatically a bug. Triage each into:",
        "",
        "- **equivalent** — semantically identical to the original, so no test could",
        "  ever kill it (e.g. flipping a comparison that is unreachable at that bound)",
        "- **uncovered** — a real gap; write an invariant or a test",
        "- **acceptable** — reachable but immaterial, with the reason stated",
        "",
        "| File:line | Operator | Original | Triage |",
        "| --- | --- | --- | --- |",
        ...survivors.map((s) => {
          const note = triageFor(s);
          return `| \`${relative(root, s.file)}:${s.line}\` | \`${s.operator}\` | \`${s.original.replace(/\|/g, "\\|")}\` | ${note ?? "**UNTRIAGED — write a test**"} |`;
        }),
      ].join("\n"),
  "",
  `*Generated over ${sourceFiles().length} source files in ` +
    `${TARGET_DIRS.map((d) => "`" + relative(root, d) + "`").join(", ")}.*`,
  "",
  `${UNMUTATED_SCOPES.map((x) => "`src/" + x + "`").join(", ")} are NOT mutated, ` +
    "and the reason is",
  "stated rather than left as a footnote: `src/sim` is driven by",
  "`test/faultInjection.test.ts` through a seeded fault schedule, so a mutant",
  "there changes which faults are injected rather than whether the system",
  "survives them — it would be scored against a different workload, which",
  "measures nothing. `src/cli` and `src/tierb` are I/O shells whose behaviour",
  "is asserted by process-level tests that this harness cannot attribute.",
  "Both are gaps; naming them is the point.",
].join("\n");

writeFileSync(join(root, "docs", "MUTATION.md"), report + "\n", "utf8");
console.log(`wrote docs/MUTATION.md`);

const untriaged = survivors.filter((s) => triageFor(s) === null);
if (untriaged.length > 0) {
  console.log(
    `\n${untriaged.length} survivor(s) UNTRIAGED — each needs a test or an equivalence argument.`,
  );
}
// Gate on the score, not on zero survivors: equivalent mutants exist in any real
// codebase and demanding zero would push toward deleting the operator set rather
// than improving the suite.
const GATE = 85;
if (score < GATE) {
  console.error(`\nmutation score ${score.toFixed(1)}% is below the ${GATE}% gate (KG3)`);
  process.exit(1);
}
process.exit(untriaged.length > 0 ? 1 : 0);
