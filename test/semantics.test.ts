import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * SEMANTICS.md is a build artifact, not prose.
 *
 * The differential oracle in M4 compares the implementation against a reference
 * model, and both are written by the same author from the same understanding. So
 * the one thing that test structurally cannot catch is a *misunderstanding* —
 * an ambiguity resolved silently, identically, in both halves.
 *
 * These checks make the document mechanically load-bearing: an undecided row
 * fails the build, so the ambiguity has to be confronted rather than absorbed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const doc = readFileSync(resolve(here, "..", "docs", "SEMANTICS.md"), "utf8");

/** Rows look like `### A1 · question`. */
function rowIds(): string[] {
  return [...doc.matchAll(/^### ([A-G]\d+) ·/gm)].map((m) => m[1] as string);
}

function statusesFor(): Array<{ id: string; status: string }> {
  const out: Array<{ id: string; status: string }> = [];
  const sections = doc.split(/^### /m).slice(1);
  for (const section of sections) {
    const id = /^([A-G]\d+) ·/.exec(section)?.[1];
    if (id === undefined) continue;
    // Allow trailing prose after the status, e.g. "`TBD` — his call."
    const status = /\*\*Status: `(DECIDED|TBD)`/.exec(section)?.[1];
    out.push({ id, status: status ?? "MISSING" });
  }
  return out;
}

describe("SEMANTICS.md", () => {
  it("exists and declares its freeze status", () => {
    expect(doc).toMatch(/\*\*Status: (DRAFT|FROZEN)/);
  });

  it("has at least 30 decision rows", () => {
    // The research put the ambiguity surface at ~30. Fewer than that means
    // questions are being absorbed silently rather than asked.
    expect(rowIds().length).toBeGreaterThanOrEqual(30);
  });

  it("gives every row a status", () => {
    const missing = statusesFor().filter((r) => r.status === "MISSING");
    expect(
      missing.map((r) => r.id),
      "rows with no Status line",
    ).toEqual([]);
  });

  it("uses unique row ids", () => {
    const ids = rowIds();
    expect(new Set(ids).size, `duplicate ids in ${ids.join(", ")}`).toBe(ids.length);
  });

  it("states a consequence for every row (an 'Else' or an explicit note)", () => {
    const sections = doc.split(/^### /m).slice(1);
    const noElse = sections
      .filter((s) => /^[A-G]\d+ ·/.test(s))
      .filter((s) => !s.includes("**Else") && !s.includes("**Known cost"))
      .map((s) => /^([A-G]\d+)/.exec(s)?.[1]);
    // A recommendation without a stated consequence is an assertion, not a
    // decision — there is nothing to disagree with.
    expect(noElse, "rows recommending an answer with no stated alternative").toEqual([]);
  });

  /**
   * THE GATE.
   *
   * Currently allowed to fail: section G is explicitly the "needs Shailesh" set,
   * and the document is still DRAFT. Once ratified, flip `ALLOW_TBD` to false —
   * that flip is what "frozen" means mechanically.
   */
  const ALLOW_TBD = true;

  it("has no TBD rows once frozen", () => {
    const tbd = statusesFor().filter((r) => r.status === "TBD");
    if (ALLOW_TBD) {
      // While drafting, only section G may be undecided. A TBD anywhere else
      // means a row was drafted without a recommendation, which defeats the
      // point of the document.
      const outsideG = tbd.filter((r) => !r.id.startsWith("G"));
      expect(
        outsideG.map((r) => r.id),
        "TBD outside the open section",
      ).toEqual([]);
    } else {
      expect(
        tbd.map((r) => r.id),
        "undecided rows in a frozen document",
      ).toEqual([]);
    }
  });

  it("was committed before any policy implementation exists", () => {
    // Documented here so the claim is checkable rather than asserted in prose:
    // `git log --diff-filter=A --format=%H -- docs/SEMANTICS.md src/policy` must
    // show SEMANTICS.md first. Asserted by eye at freeze time and recorded in
    // the README; a test cannot read git history without shelling out, and this
    // suite stays dependency-free.
    expect(doc).toContain("committed before any policy code");
  });
});
