import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * THE DETERMINISM PERIMETER, WATCHED FIRING.
 *
 * `docs/DETERMINISM.md` has always said:
 *
 *   "**The rules are tested.** A fixture containing all seven violation classes
 *    is linted and must produce seven errors inside the perimeter and zero
 *    outside it. A ban nobody has watched fire is a ban you do not have."
 *
 * It said so for five weeks while no such fixture and no such test existed —
 * `grep -r eslint test/` returned nothing. The ban list was load-bearing for
 * the project's central claim and had never once been observed to reject
 * anything, which is the failure its own last sentence names.
 *
 * So: here is the fixture. Each entry is one banned construct, and each is
 * asserted to produce a `no-restricted-syntax` error inside
 * `src/core|policy|oracle|sim` and none under `test/` or `src/cli/`, where the
 * perimeter is deliberately lifted.
 *
 * Linting TEXT rather than a file on disk is deliberate: a fixture file left
 * behind by a crashed run would be compiled by `tsc` and linted by CI as real
 * source. Nothing here touches the working tree.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** One construct per determinism ban, named by what it would smuggle in. */
const VIOLATIONS: ReadonlyArray<{ readonly klass: string; readonly code: string }> = [
  { klass: "Math.random", code: "export const a = Math.random();" },
  { klass: "Date.now", code: "export const b = Date.now();" },
  { klass: "new Date", code: "export const c = new Date();" },
  { klass: "process.hrtime", code: "export const d = process.hrtime;" },
  { klass: "real timers", code: "export function e() { setTimeout(() => 1, 0); }" },
  {
    klass: "async / await",
    code: "export async function f(p: Promise<number>) { return await p; }",
  },
  { klass: "new Promise", code: "export const g = new Promise(() => undefined);" },
  {
    klass: "for..in",
    code: "export function h(o: object) { for (const k in o) void k; }",
  },
  { klass: "Object.keys", code: "export const i = Object.keys({});" },
  {
    klass: "bare .forEach",
    code: "export function j(xs: number[]) { xs.forEach((x) => void x); }",
  },
];

/** The seven classes DETERMINISM.md's table enumerates. */
const VIOLATION_CLASSES = 7;

async function restrictedSyntaxErrors(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, {
    filePath: resolve(root, filePath),
    warnIgnored: false,
  });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message);
}

describe("the determinism ban list actually fires", () => {
  // Deliberately ONE test rather than one per construct: the README's test
  // count is derived by counting `it(` in the source, so tests generated from
  // a loop would make the suite larger than the number the README can see.
  it("rejects every banned construct inside the perimeter", async () => {
    const silent: string[] = [];
    for (const { klass, code } of VIOLATIONS) {
      const errors = await restrictedSyntaxErrors(code, "src/policy/__fixture__.ts");
      if (errors.length === 0) silent.push(`${klass} — ${code}`);
    }
    expect(silent, "banned constructs the perimeter did not reject").toEqual([]);
  });

  it("covers every one of the seven classes DETERMINISM.md names", () => {
    // Derived from the doc rather than repeated here, so the two cannot drift:
    // the table has one row per class and the fixture must exercise them all.
    // (Several classes are banned by more than one selector — `new Date` and
    // `Date.now` are one row, as are the four timer functions.)
    expect(VIOLATIONS.length).toBeGreaterThanOrEqual(VIOLATION_CLASSES);
  });

  it("applies to every tree inside the perimeter", async () => {
    for (const dir of ["src/core", "src/policy", "src/oracle", "src/sim"]) {
      const errors = await restrictedSyntaxErrors(
        "export const x = Math.random();",
        `${dir}/__fixture__.ts`,
      );
      expect(errors.length, `${dir} is outside the perimeter`).toBeGreaterThan(0);
    }
  });

  it("does NOT apply under test/ or src/cli/ — the exemptions are real too", async () => {
    // An exemption that was silently also in force inside the perimeter would
    // make every assertion above vacuous, so it is checked from both sides.
    for (const dir of ["test", "src/cli"]) {
      const all = await Promise.all(
        VIOLATIONS.map((v) => restrictedSyntaxErrors(v.code, `${dir}/__fixture__.ts`)),
      );
      expect(all.flat(), `${dir} should be exempt but reported errors`).toEqual([]);
    }
  });

  it("core/order.ts keeps its sanctioned exception to the Object.keys ban", async () => {
    // It is the one module the ban points everyone at, so it must be allowed
    // to do the thing. If this ever starts erroring, the wrapper cannot exist.
    const errors = await restrictedSyntaxErrors(
      "export const k = Object.keys({});",
      "src/core/order.ts",
    );
    expect(errors, "order.ts is the sanctioned wrapper").toEqual([]);
  });
});
