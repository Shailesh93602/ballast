/**
 * The flash sale against a REAL Postgres — the half of M2 the simulation
 * cannot do.
 *
 * `src/policy/flashSale.ts` proves the three strategies differ under a
 * deterministic interleaving that is an INPUT. This file proves the same
 * thing where the interleaving is supplied by an actual database under
 * actual concurrency — real connections, real row locks, real lost updates.
 * The two are one argument: the sim names the race, the substrate confirms
 * the database exhibits it.
 *
 * THE ORACLE IS THE ROWS, NOT THE STRATEGY'S TALLY. `sold` is COUNT(*) of
 * the orders table and `oversold` is derived from it against the initial
 * stock. The sim's mutation testing found that a strategy which miscounts
 * its own sales can report zero oversell while the row is wrong — so here,
 * as there, a strategy is never trusted about itself.
 *
 * WALL-CLOCK NUMBERS APPEAR IN THE REPORT AND NOWHERE ELSE. The simulation
 * bans wall-clock in assertions and that ban stands: nothing here asserts a
 * duration. The report prints one because "correctness cost N retries and
 * X ms under this contention" is the honest shape of the answer this
 * question is actually asking for in a design interview.
 *
 * Dev-only dependency: `pg` lives in devDependencies. The library still has
 * zero runtime dependencies; this is a harness, like vitest.
 */
import { setImmediate } from "node:timers";

import { Pool } from "pg";

import { assertSafeDatabaseUrl } from "./safety.js";

export type RealStrategy =
  "read-then-write" | "conditional-update" | "optimistic-version";

export const REAL_STRATEGIES: readonly RealStrategy[] = [
  "read-then-write",
  "conditional-update",
  "optimistic-version",
];

export interface RealSaleReport {
  readonly strategy: RealStrategy;
  readonly initialStock: number;
  readonly buyers: number;
  /** COUNT(*) of orders — recorded outcomes, never the strategy's own count. */
  readonly sold: number;
  readonly refused: number;
  /** max(0, sold − initialStock). MUST be zero for a correct strategy. */
  readonly oversold: number;
  /** What the stock row actually says afterwards. */
  readonly remainingStock: number;
  /**
   * initialStock − sold − remainingStock. Zero when every unit is accounted
   * for. The naive strategy can break THIS while oversold stays zero on a
   * lucky run — the lost update can under-decrement as easily as oversell —
   * so both are checked.
   */
  readonly conservationError: number;
  readonly totalRetries: number;
  readonly wallMs: number;
}

const SKU = 1;
/** Optimistic retries per buyer. Refusing after this is an outcome, not a bug. */
const MAX_OPTIMISTIC_RETRIES = 25;

export function poolFor(url: string): Pool {
  // Same gate as every Tier-B touch: local host, exact throwaway DB name, no
  // pasted production credentials. Checked before a single connection opens.
  assertSafeDatabaseUrl(url);
  return new Pool({ connectionString: url, max: 20 });
}

export async function setupSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fs_stock (
      id      int PRIMARY KEY,
      stock   int NOT NULL,
      version int NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS fs_orders (
      id    serial PRIMARY KEY,
      buyer text NOT NULL,
      sku   int  NOT NULL
    );
  `);
}

export async function resetSale(pool: Pool, stock: number): Promise<void> {
  await pool.query(`TRUNCATE fs_orders`);
  await pool.query(
    `INSERT INTO fs_stock (id, stock, version) VALUES ($1, $2, 0)
     ON CONFLICT (id) DO UPDATE SET stock = $2, version = 0`,
    [SKU, stock],
  );
}

interface BuyResult {
  readonly sold: boolean;
  readonly retries: number;
}

/**
 * The version everyone writes first. Read the stock, decide, write the
 * computed value. Every statement is individually correct; the bug is the
 * gap between them, which a second connection fills. No transaction, no
 * condition — the write clobbers whatever landed in between (a lost update).
 */
async function buyNaive(pool: Pool, buyer: string): Promise<BuyResult> {
  const read = await pool.query(`SELECT stock FROM fs_stock WHERE id = $1`, [SKU]);
  const stock: number = read.rows[0].stock;
  if (stock <= 0) return { sold: false, retries: 0 };

  // The window between read and write. `setImmediate` is one event-loop
  // yield — the moral equivalent of "compute the new value, maybe log
  // something" in real code. It widens nothing the network round-trip has
  // not already opened; it makes the demonstration reproducible instead of
  // load-dependent.
  await new Promise((r) => setImmediate(r));

  await pool.query(`UPDATE fs_stock SET stock = $2 WHERE id = $1`, [SKU, stock - 1]);
  await pool.query(`INSERT INTO fs_orders (buyer, sku) VALUES ($1, $2)`, [buyer, SKU]);
  return { sold: true, retries: 0 };
}

/**
 * The condition lives INSIDE the mutation. Postgres takes the row lock,
 * re-evaluates `stock > 0` against the committed row, and the loser updates
 * zero rows. The order insert shares the transaction, so "a unit left the
 * shelf" and "someone owns it" commit together or not at all.
 */
async function buyConditional(pool: Pool, buyer: string): Promise<BuyResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const upd = await client.query(
      `UPDATE fs_stock SET stock = stock - 1 WHERE id = $1 AND stock > 0`,
      [SKU],
    );
    if (upd.rowCount === 1) {
      await client.query(`INSERT INTO fs_orders (buyer, sku) VALUES ($1, $2)`, [
        buyer,
        SKU,
      ]);
      await client.query("COMMIT");
      return { sold: true, retries: 0 };
    }
    await client.query("ROLLBACK");
    return { sold: false, retries: 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Read free of locks, then commit only if nobody moved the version. A miss
 * costs a retry rather than a wrong write. Wins when contention is rare;
 * under a flash sale's contention it pays for its optimism in retries —
 * which the report shows, and which is the trade-off the interview question
 * is really about.
 */
async function buyOptimistic(pool: Pool, buyer: string): Promise<BuyResult> {
  for (let attempt = 0; attempt <= MAX_OPTIMISTIC_RETRIES; attempt++) {
    const read = await pool.query(`SELECT stock, version FROM fs_stock WHERE id = $1`, [
      SKU,
    ]);
    const { stock, version } = read.rows[0] as { stock: number; version: number };
    if (stock <= 0) return { sold: false, retries: attempt };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const upd = await client.query(
        `UPDATE fs_stock SET stock = $2, version = version + 1
         WHERE id = $1 AND version = $3`,
        [SKU, stock - 1, version],
      );
      if (upd.rowCount === 1) {
        await client.query(`INSERT INTO fs_orders (buyer, sku) VALUES ($1, $2)`, [
          buyer,
          SKU,
        ]);
        await client.query("COMMIT");
        return { sold: true, retries: attempt };
      }
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return { sold: false, retries: MAX_OPTIMISTIC_RETRIES };
}

const BUYERS: Record<RealStrategy, (pool: Pool, buyer: string) => Promise<BuyResult>> = {
  "read-then-write": buyNaive,
  "conditional-update": buyConditional,
  "optimistic-version": buyOptimistic,
};

export async function runRealSale(
  pool: Pool,
  strategy: RealStrategy,
  initialStock: number,
  buyerCount: number,
): Promise<RealSaleReport> {
  await resetSale(pool, initialStock);

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: buyerCount }, (_, i) => BUYERS[strategy](pool, `b-${i}`)),
  );
  const wallMs = Date.now() - started;

  // The oracle: what the DATABASE says happened.
  const orderCount = Number(
    (await pool.query(`SELECT count(*) AS n FROM fs_orders`)).rows[0].n,
  );
  const remainingStock: number = (
    await pool.query(`SELECT stock FROM fs_stock WHERE id = $1`, [SKU])
  ).rows[0].stock;

  return {
    strategy,
    initialStock,
    buyers: buyerCount,
    sold: orderCount,
    refused: results.filter((r) => !r.sold).length,
    oversold: Math.max(0, orderCount - initialStock),
    remainingStock,
    conservationError: initialStock - orderCount - remainingStock,
    totalRetries: results.reduce((a, r) => a + r.retries, 0),
    wallMs,
  };
}
