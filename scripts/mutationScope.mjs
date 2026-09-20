import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

/**
 * Which source is mutated, and which test files can observe a mutation.
 *
 * Extracted from `mutate.mjs` so a test can import it: that script runs the
 * whole mutation campaign on import, so anything importable from it would cost
 * an hour to assert.
 *
 * WHY THE APPARATUS IS MUTATED. The harness covered `src/policy` only, and the
 * footnote said so without justifying it. That exclusion was exactly backwards:
 * of the findings in LEDGER.md, more than half were in the CHECKER, the
 * REFERENCE ORACLE or the HARNESS rather than in the system under test — I4
 * comparing a map to itself, a fault injector wired to nothing, a mutation
 * operator that did not mutate. The layer with the worst track record was the
 * one layer nothing was allowed to mutate.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "..");

export const MUTATED_SCOPES = ["policy", "oracle", "core"];
export const TARGET_DIRS = MUTATED_SCOPES.map((d) => join(root, "src", d));

/**
 * `src/sim`, `src/cli` and `src/tierb` are NOT mutated, and the reason is
 * stated rather than left as a footnote — see docs/MUTATION.md.
 */
export const UNMUTATED_SCOPES = ["sim", "cli", "tierb"];

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Can `entry` observe a change to the mutated source, through any chain of
 * local imports?
 *
 * Computed rather than listed. A hand-maintained exclusion list is a thing that
 * rots silently: a test file that later starts importing the control plane
 * would keep being skipped and the score would quietly stop measuring it.
 */
export function reachesMutatedCode(entry) {
  return reaches(entry, (file) => TARGET_DIRS.some((d) => file.startsWith(`${d}/`)));
}

/**
 * Can `entry` observe a change to THIS ONE file?
 *
 * Per-mutant test selection, which is what Stryker does and what makes a
 * campaign finish. It is the same walk with a narrower target, so its soundness
 * argument is the same one: a test that cannot reach the mutated module through
 * any chain of local imports cannot observe the mutation, and running it is
 * pure cost. The risk is under-reading — a mutant graded against too few tests
 * reads as a survivor — so `test/mutation.test.ts` asserts the walk in both
 * directions and the triage of every survivor is done by hand anyway.
 */
export function reachesFile(entry, target) {
  return reaches(entry, (file) => file === target);
}

function reaches(entry, isTarget) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (isTarget(file)) return true;
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
      const next = resolveLocal(file, m[1]);
      if (next !== null) stack.push(next);
    }
  }
  return false;
}

export function allTestFiles() {
  return readdirSync(join(root, "test"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => join(root, "test", f));
}

/** The test files a mutant is graded against, and the ones it cannot reach. */
export function gradedSuite() {
  const all = allTestFiles();
  return {
    graded: all.filter(reachesMutatedCode),
    skipped: all.filter((f) => !reachesMutatedCode(f)),
  };
}
