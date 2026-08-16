import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

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

/** Count `it(` occurrences across the suite — the honest test count. */
function countTests(): number {
  return testFiles().reduce((n, src) => n + (src.match(/^\s{2}it\(/gm) ?? []).length, 0);
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
    const sources = testFiles().join("\n");
    const corpusClaims: Array<{ label: string; needle: RegExp }> = [
      { label: "1,000 determinism seeds", needle: /SEED_COUNT = 1000/ },
      { label: "2,000 invariant histories", needle: /seed <= 2000/ },
      { label: "300 differential histories", needle: /seed <= 300/ },
      { label: "500 KhataGO protocol runs", needle: /seed <= 500/ },
      { label: "60 fairness seeds", needle: /seed <= 60/ },
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

  it("the fairness figures match the fairness test", () => {
    const src = readFileSync(join(root, "test", "fairness.test.ts"), "utf8");
    // 1.000x isolation is asserted exactly.
    expect(readme).toContain("**1.000×**");
    expect(src, "the isolation claim must be an exact assertion").toMatch(
      /\)\.toBe\(1\)/,
    );
    // The starvation figure must be a real count over 60 seeds.
    expect(readme).toMatch(/\*\*38 of 60\*\*/);
    expect(src).toMatch(/seed <= 60/);
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
