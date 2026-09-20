import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_CONFIG, runSimulation, NaivePolicy } from "../src/core/simulate.js";
import { Rng } from "../src/core/rng.js";
import { EventQueue } from "../src/core/clock.js";
import { ControlPlane } from "../src/policy/controlPlane.js";
import { DEFAULT_CONTROL_PLANE } from "../src/policy/types.js";

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

/**
 * THE SAME GUARD, POINTED AT THE CONTROL PLANE.
 *
 * Everything above runs `NaivePolicy` — the M0 placeholder whose own docstring
 * says it "is NOT the control plane and makes no correctness claim". It exists
 * so the spine has a decision stream to hash. That made the headline number
 * ("1,000 seeds byte-identical") a statement about a fifty-line toy with one
 * counter and one RNG draw, while `ControlPlane`, `ReplayLog` and `Substrate`
 * — the three things the project is actually about — had no determinism guard
 * at all.
 *
 * The claim turns out to hold for them. But an unguarded true claim is one
 * refactor away from an unguarded false one, and "we checked the wrong
 * artifact" is the failure this workspace has already been bitten by twice.
 */
describe("determinism guard — the CONTROL PLANE", () => {
  const CP_SEEDS = 500;

  /** A seeded workload driven entirely through the three real operations. */
  function planeHash(seed: number): string {
    const rng = new Rng(seed);
    const plane = new ControlPlane(DEFAULT_CONTROL_PLANE);
    const tenants = DEFAULT_CONTROL_PLANE.tenants.map((t) => t.id);
    const held = new Map<string, { slotId: string; token: number }>();
    const h = createHash("sha256");
    let vtime = 0;

    for (let i = 0; i < 120; i++) {
      vtime += rng.nextInt(0, 4);
      const runId = `r${i}`;
      const roll = rng.nextInt(0, 100);
      if (roll < 55 || held.size === 0) {
        const tenant = tenants[rng.nextInt(0, tenants.length)] as string;
        const r = plane.admit(vtime, tenant, runId);
        if (r.ok) held.set(runId, { slotId: r.slotId, token: r.token });
        h.update(JSON.stringify(r));
      } else {
        const keys = [...held.keys()].sort();
        const victim = keys[rng.nextInt(0, keys.length)] as string;
        const slot = held.get(victim);
        held.delete(victim);
        if (roll < 75)
          h.update(JSON.stringify(plane.complete(vtime, victim, "completed")));
        else if (roll < 90 && slot !== undefined)
          h.update(JSON.stringify(plane.release(vtime, slot.slotId, slot.token)));
        else h.update(plane.cancel(vtime, victim));
      }
      // Final state, order-insensitively: the maps the plane exposes iterate in
      // tenant-CONSTRUCTION order, so serializing them raw would make this
      // guard fail for a config reordering rather than for nondeterminism.
      h.update(
        `${plane.totalClaimed}|${sortedPairs(plane.inFlightByTenant())}|` +
          `${sortedPairs(plane.creditsSpentMap())}|${JSON.stringify(plane.log.assignedIds())}`,
      );
    }
    return h.digest("hex");
  }

  function sortedPairs(m: ReadonlyMap<string, number>): string {
    return JSON.stringify(
      [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    );
  }

  it(`is byte-identical across ${CP_SEEDS} seeds run twice in-process`, () => {
    const mismatches: number[] = [];
    for (let seed = 1; seed <= CP_SEEDS; seed++) {
      if (planeHash(seed) !== planeHash(seed)) mismatches.push(seed);
    }
    expect(mismatches, "control-plane seeds that differed between two runs").toEqual([]);
  });

  it("produces DIFFERENT logs for different seeds (guard is not vacuous)", () => {
    const hashes = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) hashes.add(planeHash(seed));
    expect(hashes.size).toBeGreaterThan(190);
  });

  it("does not depend on the ORDER the tenants were configured in", () => {
    // Construction order is the subtlest determinism leak there is, and the
    // control plane seeds three Maps from `config.tenants` in array order.
    // `runSimulation` guards this explicitly (it sorts the tenant list);
    // `ControlPlane` does not, so the property is asserted instead.
    const forward = DEFAULT_CONTROL_PLANE;
    const reversed = {
      ...DEFAULT_CONTROL_PLANE,
      tenants: [...DEFAULT_CONTROL_PLANE.tenants].reverse(),
    };
    const decisionsFor = (cfg: typeof forward, seed: number): string => {
      const rng = new Rng(seed);
      const plane = new ControlPlane(cfg);
      const tenants = DEFAULT_CONTROL_PLANE.tenants.map((t) => t.id);
      const out: string[] = [];
      let vtime = 0;
      for (let i = 0; i < 80; i++) {
        vtime += rng.nextInt(0, 4);
        const tenant = tenants[rng.nextInt(0, tenants.length)] as string;
        const r = plane.admit(vtime, tenant, `r${i}`);
        out.push(r.ok ? `admit:${r.slotId}:${r.token}` : `reject:${r.reason}`);
      }
      return out.join("|");
    };
    for (let seed = 1; seed <= 100; seed++) {
      expect(
        decisionsFor(reversed, seed),
        `seed ${seed}: reordering the tenant config changed the decisions`,
      ).toBe(decisionsFor(forward, seed));
    }
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
