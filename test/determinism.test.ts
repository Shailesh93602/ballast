import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DEFAULT_CONFIG, runSimulation, NaivePolicy } from "../src/core/simulate.js";
import { Rng } from "../src/core/rng.js";
import { EventQueue } from "../src/core/clock.js";

/**
 * THE DETERMINISM GUARD.
 *
 * This is the test the whole project rests on. If it ever goes red, no claim in
 * the README means anything, because every other result is quoted against a
 * seed and a seed is only a reference if it reproduces.
 *
 * It checks three things that fail for different reasons:
 *   1. same seed, twice in ONE process   → catches ambient state carried between
 *                                          runs (module-level RNG, caches, counters)
 *   2. same seed, in a FRESH process     → catches anything seeded by the engine
 *                                          or the environment (hash seeds,
 *                                          iteration order that varies per boot)
 *   3. different seeds diverge           → catches a guard that passes vacuously
 *                                          because the simulation ignores its seed
 *
 * (3) matters more than it looks. A simulation that always emitted the same log
 * would sail through (1) and (2) forever.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function hashFor(seed: number): string {
  return runSimulation({ ...DEFAULT_CONFIG, seed }, new NaivePolicy(4)).log.hash();
}

/**
 * Run the simulation in a genuinely separate node process, against the BUILT
 * output rather than the TypeScript sources.
 *
 * Deliberate: `dist/` is what actually ships and what the `ballast` bin runs, so
 * a guard that only ever exercised the source could pass while the published
 * artifact behaved differently. (The workspace has been bitten by exactly that
 * shape before — a middleware test that imported a module the framework never
 * loaded.) Building here costs a couple of seconds once and buys a guard that
 * covers the real thing.
 */
function hashInFreshProcess(seed: number): string {
  const script = `
    import { runSimulation, DEFAULT_CONFIG, NaivePolicy } from ${JSON.stringify(
      resolve(repoRoot, "dist/core/simulate.js"),
    )};
    const r = runSimulation({ ...DEFAULT_CONFIG, seed: ${seed} }, new NaivePolicy(4));
    process.stdout.write(r.log.hash());
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    cwd: repoRoot,
  }).trim();
}

/** Build once for the whole file, so the cross-process check has a dist to load. */
function ensureBuilt(): void {
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
}

describe("determinism guard", () => {
  const SEED_COUNT = 1000;

  it(`is byte-identical across ${SEED_COUNT} seeds run twice in-process`, () => {
    const mismatches: number[] = [];
    for (let seed = 1; seed <= SEED_COUNT; seed++) {
      if (hashFor(seed) !== hashFor(seed)) mismatches.push(seed);
    }
    expect(mismatches, `seeds that differed between two in-process runs`).toEqual([]);
  });

  it("is byte-identical in a fresh process, against the BUILT artifact (sampled)", () => {
    ensureBuilt();
    // A fresh process per seed costs ~100ms, so this samples rather than
    // sweeping. The in-process check above carries the breadth; this one exists
    // to catch per-boot nondeterminism, which is not seed-specific — if it is
    // broken at all, it is broken for every seed.
    for (const seed of [1, 7, 42, 999, 4711]) {
      expect(hashInFreshProcess(seed), `seed ${seed} across processes`).toBe(
        hashFor(seed),
      );
    }
  });

  it("produces DIFFERENT logs for different seeds (guard is not vacuous)", () => {
    const hashes = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) hashes.add(hashFor(seed));
    // Not all 200 need be unique, but near-total uniqueness is the signal that
    // the seed actually drives the run.
    expect(hashes.size).toBeGreaterThan(190);
  });

  it("produces a non-empty decision log (nothing to be identical about otherwise)", () => {
    const r = runSimulation({ ...DEFAULT_CONFIG, seed: 1 }, new NaivePolicy(4));
    expect(r.log.length).toBeGreaterThan(0);
    expect(r.eventsProcessed).toBeGreaterThan(0);
  });
});

describe("Rng", () => {
  it("is reproducible from a seed", () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 100; i++) expect(a.nextInt(0, 1000)).toBe(b.nextInt(0, 1000));
  });

  it("diverges for different seeds", () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const seqA = Array.from({ length: 20 }, () => a.nextInt(0, 1_000_000));
    const seqB = Array.from({ length: 20 }, () => b.nextInt(0, 1_000_000));
    expect(seqA).not.toEqual(seqB);
  });

  it("forks into independent streams that do not correlate", () => {
    const base = new Rng(99);
    const x = base.fork("faults");
    const base2 = new Rng(99);
    const y = base2.fork("arrivals");
    const seqX = Array.from({ length: 20 }, () => x.nextInt(0, 1_000_000));
    const seqY = Array.from({ length: 20 }, () => y.nextInt(0, 1_000_000));
    expect(seqX).not.toEqual(seqY);
  });

  it("forks reproducibly for the same label", () => {
    const a = new Rng(7).fork("faults");
    const b = new Rng(7).fork("faults");
    expect(a.nextInt(0, 1e6)).toBe(b.nextInt(0, 1e6));
  });

  it("respects nextInt bounds", () => {
    const r = new Rng(3);
    for (let i = 0; i < 5000; i++) {
      const v = r.nextInt(5, 9);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(9);
    }
  });

  it("rejects an empty range rather than silently returning min", () => {
    const r = new Rng(1);
    expect(() => r.nextInt(4, 4)).toThrow(/empty range/);
  });

  it("does not exhibit obvious modulo bias on a small range", () => {
    // Rejection sampling should keep four buckets within a few percent of each
    // other over 40k draws. A modulo implementation skews the low buckets.
    const r = new Rng(2024);
    const counts = [0, 0, 0, 0];
    const N = 40000;
    for (let i = 0; i < N; i++) counts[r.nextInt(0, 4)]!++;
    for (const c of counts) expect(Math.abs(c - N / 4) / (N / 4)).toBeLessThan(0.05);
  });
});

describe("EventQueue ordering", () => {
  it("orders by vtime, then by insertion sequence", () => {
    const q = new EventQueue<string>();
    q.schedule(5, "b-second");
    q.schedule(1, "a");
    q.schedule(5, "b-third");
    q.schedule(5, "b-fourth");
    q.schedule(2, "middle");
    const out: string[] = [];
    for (;;) {
      const e = q.pop();
      if (e === undefined) break;
      out.push(e.payload);
    }
    expect(out).toEqual(["a", "middle", "b-second", "b-third", "b-fourth"]);
  });

  it("never compares two events as equal, whatever the insertion pattern", () => {
    // Same tick for everything: ordering must fall entirely to seq, and must be
    // exactly insertion order.
    const q = new EventQueue<number>();
    for (let i = 0; i < 500; i++) q.schedule(7, i);
    const out: number[] = [];
    for (;;) {
      const e = q.pop();
      if (e === undefined) break;
      out.push(e.payload);
    }
    expect(out).toEqual(Array.from({ length: 500 }, (_, i) => i));
  });

  it("rejects fractional ticks", () => {
    const q = new EventQueue<string>();
    expect(() => q.schedule(1.5, "x")).toThrow(/integer tick/);
  });
});
