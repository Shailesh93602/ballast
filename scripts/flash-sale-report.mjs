#!/usr/bin/env node
/**
 * Run all three strategies against the local throwaway Postgres and print
 * the comparison. The numbers this prints are generated fresh on every run —
 * nothing here is stored, so nothing here can go stale.
 *
 *   createdb khatago_ballast   (once)
 *   npm run flash-sale:real
 */
import {
  poolFor,
  runRealSale,
  setupSchema,
  REAL_STRATEGIES,
} from "../dist/tierb/flashSaleReal.js";

const URL =
  process.env.BALLAST_TIERB_URL ?? "postgresql://localhost:5432/khatago_ballast";
const STOCK = Number(process.env.STOCK ?? 5);
const BUYERS = Number(process.env.BUYERS ?? 200);

const pool = poolFor(URL);
await setupSchema(pool);

console.log(`flash sale: ${STOCK} units, ${BUYERS} concurrent buyers\n`);
const rows = [];
for (const strategy of REAL_STRATEGIES) {
  rows.push(await runRealSale(pool, strategy, STOCK, BUYERS));
}
await pool.end();

console.table(
  rows.map((r) => ({
    strategy: r.strategy,
    sold: r.sold,
    refused: r.refused,
    OVERSOLD: r.oversold,
    "conservation err": r.conservationError,
    retries: r.totalRetries,
    ms: r.wallMs,
  })),
);
const broken = rows.find((r) => r.strategy === "read-then-write");
if (broken && (broken.oversold > 0 || broken.conservationError !== 0)) {
  console.log(
    `\nread-then-write sold ${broken.sold} of ${STOCK} units` +
      ` (oversold ${broken.oversold}, conservation error ${broken.conservationError}).` +
      `\nEvery read it made was correct at the moment it happened. That is why this bug survives review.`,
  );
}
