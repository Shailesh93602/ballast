import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  poolFor,
  runRealSale,
  setupSchema,
  REAL_STRATEGIES,
} from "../src/tierb/flashSaleReal.js";
import type { Pool } from "pg";

/**
 * The flash sale against a REAL Postgres.
 *
 * The sim (test/flashSale.test.ts) proves the strategies differ under an
 * interleaving that is an input. This suite proves the database supplies
 * that interleaving unprompted: 200 concurrent buyers, 5 units, real
 * connections, real row locks.
 *
 * SKIPPED, LOUDLY, WHEN THE DATABASE IS ABSENT. Ballast's CI has no
 * Postgres, and a suite that fails for environmental reasons teaches people
 * to ignore it. Locally: `createdb khatago_ballast && npm test`. The skip is
 * printed, not silent — an invisible skip is how coverage quietly becomes a
 * lie.
 */
const URL =
  process.env["BALLAST_TIERB_URL"] ?? "postgresql://localhost:5432/khatago_ballast";

async function databaseAvailable(): Promise<Pool | null> {
  try {
    const pool = poolFor(URL);
    await pool.query("SELECT 1");
    return pool;
  } catch {
    return null;
  }
}

const pool = await databaseAvailable();
if (!pool) {
  console.warn(`[flashSaleReal] SKIPPED — no local Postgres at ${URL}`);
}

const STOCK = 5;
const BUYERS = 200;

describe.skipIf(!pool)("flash sale on a real Postgres", () => {
  beforeAll(async () => {
    await setupSchema(pool!);
  });
  afterAll(async () => {
    await pool!.end();
  });

  it("read-then-write OVERSELLS under real concurrency", async () => {
    // The demonstration, not an accident: every read this strategy makes is
    // correct at the moment it happens, and 200 concurrent buyers make the
    // gap between read and write impossible to thread luckily. If this ever
    // passes with zero oversold, the harness has stopped generating
    // contention and THAT is the bug to chase.
    const report = await runRealSale(pool!, "read-then-write", STOCK, BUYERS);
    expect(report.oversold).toBeGreaterThan(0);
  });

  it("conditional-update NEVER oversells, and accounts for every unit", async () => {
    const report = await runRealSale(pool!, "conditional-update", STOCK, BUYERS);
    expect(report.oversold).toBe(0);
    expect(report.sold).toBe(STOCK);
    expect(report.remainingStock).toBe(0);
    expect(report.conservationError).toBe(0);
  });

  it("optimistic-version NEVER oversells — and pays for it in retries", async () => {
    const report = await runRealSale(pool!, "optimistic-version", STOCK, BUYERS);
    expect(report.oversold).toBe(0);
    expect(report.sold).toBe(STOCK);
    expect(report.conservationError).toBe(0);
    // The trade-off is the lesson: correctness via optimism costs retries
    // under contention. Zero retries at 40x oversubscription would mean the
    // buyers ran sequentially — no contention, nothing demonstrated.
    expect(report.totalRetries).toBeGreaterThan(0);
  });

  it("the oracle counts rows, not the strategy's claims", async () => {
    // Conservation, checked across all three from the DATABASE's numbers.
    // For the correct strategies every unit is either on the shelf or in an
    // order; the naive one violates it — that violation is the point.
    for (const strategy of REAL_STRATEGIES) {
      const r = await runRealSale(pool!, strategy, STOCK, BUYERS);
      if (strategy === "read-then-write") {
        expect(
          r.oversold > 0 || r.conservationError !== 0,
          "naive strategy produced a perfectly conserved sale — contention is gone",
        ).toBe(true);
      } else {
        expect(r.conservationError).toBe(0);
      }
    }
  });
});
