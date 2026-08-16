#!/usr/bin/env node
/**
 * Mechanical mutation testing over `src/policy/**`.
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

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const TARGET_DIR = join(root, "src", "policy");
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
  return readdirSync(TARGET_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(TARGET_DIR, f));
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
          const mutatedLine =
            op.name === "bool:negate-if"
              ? line.slice(0, match.index) + "if (!" + line.slice(match.index + 4)
              : line.slice(0, match.index) +
                op.replace +
                line.slice(match.index + match[0].length);
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

function runSuite() {
  try {
    execFileSync("npx", ["vitest", "run", "--reporter=dot"], {
      cwd: root,
      stdio: "pipe",
      encoding: "utf8",
      timeout: 120_000,
    });
    return true; // suite passed -> mutant SURVIVED
  } catch {
    return false; // suite failed -> mutant KILLED
  }
}

const mutants = buildMutants();
const selected = QUICK ? mutants.filter((_, i) => i % 4 === 0) : mutants;

console.log(
  `Mutation testing over src/policy — ${selected.length} mutants` +
    (QUICK ? ` (quick: 1 in 4 of ${mutants.length})` : ""),
);
console.log("─".repeat(72));

const survivors = [];
let killed = 0;
const originals = new Map();
for (const f of sourceFiles()) originals.set(f, readFileSync(f, "utf8"));

let idx = 0;
for (const m of selected) {
  idx++;
  writeFileSync(m.file, m.content, "utf8");
  const survived = runSuite();
  writeFileSync(m.file, originals.get(m.file), "utf8");

  if (survived) {
    survivors.push(m);
    console.log(
      `SURVIVED  ${relative(root, m.file)}:${m.line}  ${m.operator}\n            ${m.original}`,
    );
  } else {
    killed++;
  }
  if (idx % 10 === 0) {
    console.log(
      `… ${idx}/${selected.length}  killed=${killed} survived=${survivors.length}`,
    );
  }
}

// Restore everything, defensively.
for (const [f, src] of originals) writeFileSync(f, src, "utf8");

const score = selected.length === 0 ? 0 : (killed / selected.length) * 100;
console.log("─".repeat(72));
console.log(`killed ${killed}/${selected.length}   mutation score ${score.toFixed(1)}%`);

/**
 * Hand triage for survivors that are genuinely EQUIVALENT.
 *
 * Kept in the script so the report stays regenerable — a triage note written
 * into the generated markdown would be overwritten on the next run, and a triage
 * that disappears is worse than none.
 *
 * Keyed by "file:line:operator". Only `equivalent` belongs here. A survivor that
 * is `uncovered` gets a TEST, not an entry.
 */
const TRIAGE = {
  "src/policy/replayLog.ts:cmp:<=-><:available":
    "EQUIVALENT — when `available` is exactly 0, the guarded path calls " +
    "readFrom(cursor, 0), which returns an empty list anyway. Behaviour is " +
    "identical either way; the guard is an early return, not a correctness check.",
};

function triageFor(s) {
  for (const [key, note] of Object.entries(TRIAGE)) {
    const [file] = key.split(":");
    if (relative(root, s.file) === file && key.includes(s.operator)) return note;
  }
  return null;
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
  `- Mutants generated: **${selected.length}**${QUICK ? ` (quick sample of ${mutants.length})` : ""}`,
  `- Killed: **${killed}**`,
  `- Survived: **${survivors.length}**`,
  `- **Mutation score: ${score.toFixed(1)}%**`,
  "",
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
  `*Generated over ${sourceFiles().length} source files in \`src/policy\`.*`,
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
