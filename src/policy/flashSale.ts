/**
 * Flash sale: N units, far more buyers, and it must never oversell.
 *
 * WHY THIS IS HERE.
 *
 * This is the system-design question Salesforce reportedly asks — a high
 * concurrency problem where CONSISTENCY IS CHOSEN OVER AVAILABILITY. Selling
 * the last unit twice is unrecoverable in a way that refusing a buyer who could
 * have been served is not: one is a promise you cannot keep, the other is a
 * customer who tries again.
 *
 * It is also the same shape as this repo's admission control, one layer down.
 * A per-tenant concurrency cap and a per-SKU stock count are both "a bounded
 * resource under contention", and the mechanism that makes one correct makes
 * the other correct. Modelling it here reuses the determinism spine, the
 * invariant checker and the shrinker instead of building a fourth of each.
 *
 * WHAT IT DEMONSTRATES.
 *
 * Three strategies behind one interface, differing ONLY in how they claim a
 * unit. Under a deterministic interleaving the naive one oversells and the
 * other two do not — and that difference is the entire lesson. It is not a
 * throughput benchmark: this repo measures virtual ticks and bans wall-clock
 * numbers, and a throughput comparison would answer a question nobody asked.
 * The question is which of these is CORRECT.
 */

export type StrategyName =
  "read-then-write" | "conditional-update" | "optimistic-version";

export interface SaleOutcome {
  readonly buyer: string;
  readonly sold: boolean;
  /** Why it was refused, or how it was won. Carried so a trace explains itself. */
  readonly reason: string;
  /** Retries this buyer needed. Zero for the naive strategy — it never retries. */
  readonly attempts: number;
}

export interface SaleReport {
  readonly strategy: StrategyName;
  readonly initialStock: number;
  readonly sold: number;
  readonly refused: number;
  /** Units sold beyond stock. MUST be zero. The whole point. */
  readonly oversold: number;
  /** Total retries across all buyers — the price paid for correctness. */
  readonly totalRetries: number;
  /**
   * Stock left in the row when the sale ended.
   *
   * Reported because `sold` alone cannot detect a strategy that corrupts the
   * count. A decrement that subtracts two, or a write that silently does
   * nothing, leaves `sold` looking perfectly reasonable while the underlying
   * row is wrong — and the row is what the next sale reads.
   *
   * Mutation testing found this gap: several mutants changed the arithmetic
   * inside the row and every assertion still passed, because nothing ever
   * looked at the row.
   */
  readonly remainingStock: number;
  readonly outcomes: readonly SaleOutcome[];
}

/**
 * A row that behaves like a database row under READ COMMITTED, including the
 * part that makes concurrency hard: a read is a SNAPSHOT, and the value can
 * change before the write lands.
 *
 * `interleave` is what makes this a test rather than a demonstration. It is the
 * point at which another buyer's committed write becomes visible — supplied by
 * the caller, so the interleaving is deterministic and reproducible rather than
 * a race we hope to hit.
 */
class StockRow {
  private value: number;
  /** Bumped on every write. This is what optimistic concurrency compares. */
  private version = 0;

  constructor(initial: number) {
    this.value = initial;
  }

  read(): { stock: number; version: number } {
    return { stock: this.value, version: this.version };
  }

  /** The row as it actually stands — not what any strategy believes. */
  get current(): number {
    return this.value;
  }

  /** An UNGUARDED write. Whatever the caller computed, applied blindly. */
  write(next: number): void {
    this.value = next;
    this.version++;
  }

  /**
   * `UPDATE ... SET stock = stock - 1 WHERE stock > 0`.
   *
   * The predicate is evaluated INSIDE the mutation, against the current row,
   * not against something the caller read earlier. Returns rows affected.
   */
  decrementIfPositive(): number {
    if (this.value <= 0) return 0;
    this.value--;
    this.version++;
    return 1;
  }

  /**
   * `UPDATE ... SET stock = ? WHERE version = ?` — compare-and-set.
   *
   * Fails if anyone else wrote since the caller read. Returns rows affected.
   */
  writeIfVersion(expectedVersion: number, next: number): number {
    if (this.version !== expectedVersion) return 0;
    this.value = next;
    this.version++;
    return 1;
  }
}

export interface Buyer {
  readonly id: string;
  /**
   * Buyers whose writes land between THIS buyer's read and its write.
   *
   * This is the interleaving, stated explicitly. A concurrency bug that only
   * appears when the scheduler cooperates is not testable; one you can name is.
   */
  readonly interleavedBy?: readonly string[];
}

/**
 * Run a sale under one strategy.
 *
 * Deterministic by construction: the buyer order and the interleavings are
 * inputs, so the same arguments always produce the same report, and a failure
 * replays exactly.
 */
export function runSale(
  strategy: StrategyName,
  initialStock: number,
  buyers: readonly Buyer[],
): SaleReport {
  const row = new StockRow(initialStock);
  const outcomes: SaleOutcome[] = [];
  let totalRetries = 0;

  // Buyers whose purchase has been interleaved into someone else's window
  // already, so they are not processed again in their own turn.
  const consumed = new Set<string>();

  const buy = (buyer: Buyer): SaleOutcome => {
    switch (strategy) {
      /**
       * The version everyone writes first, and the reason this file exists.
       *
       * Read the stock, decide, then write. The read is correct AT THE MOMENT
       * IT HAPPENS — which is exactly why this survives review. Between the
       * read and the write, another buyer commits, and this buyer writes a
       * value computed from stock that no longer exists.
       */
      case "read-then-write": {
        const { stock } = row.read();
        if (stock <= 0) {
          return { buyer: buyer.id, sold: false, reason: "sold out", attempts: 1 };
        }

        // The window. Anyone listed here commits before our write lands.
        for (const otherId of buyer.interleavedBy ?? []) {
          if (consumed.has(otherId)) continue;
          consumed.add(otherId);
          const inner = row.read();
          if (inner.stock > 0) {
            row.write(inner.stock - 1);
            outcomes.push({
              buyer: otherId,
              sold: true,
              reason: "sold (interleaved)",
              attempts: 1,
            });
          } else {
            outcomes.push({
              buyer: otherId,
              sold: false,
              reason: "sold out",
              attempts: 1,
            });
          }
        }

        // Writes `stock - 1` from the value read BEFORE the interleaving. This
        // is the lost update: it silently restores stock that was consumed.
        row.write(stock - 1);
        return { buyer: buyer.id, sold: true, reason: "sold", attempts: 1 };
      }

      /**
       * One conditional UPDATE. The predicate travels with the mutation, so
       * there is no window to lose — the database evaluates `stock > 0` against
       * the row as it is when the write executes.
       *
       * This is the same mechanism as the admission cap in controlPlane.ts and
       * the PENDING->PROCESSING claim in khatagoClaim.ts.
       */
      case "conditional-update": {
        for (const otherId of buyer.interleavedBy ?? []) {
          if (consumed.has(otherId)) continue;
          consumed.add(otherId);
          const won = row.decrementIfPositive();
          outcomes.push({
            buyer: otherId,
            sold: won === 1,
            reason: won === 1 ? "sold (interleaved)" : "sold out",
            attempts: 1,
          });
        }

        const affected = row.decrementIfPositive();
        return affected === 1
          ? { buyer: buyer.id, sold: true, reason: "sold", attempts: 1 }
          : { buyer: buyer.id, sold: false, reason: "sold out", attempts: 1 };
      }

      /**
       * Compare-and-set on a version column, retrying on conflict.
       *
       * Also correct, and strictly more expensive under contention: every loser
       * of a race does its work again. It earns that cost when the update is
       * something a WHERE clause cannot express — a computed price, a decision
       * needing application logic. For "subtract one if positive" it is the
       * wrong tool, and saying so is the point of including it.
       */
      case "optimistic-version": {
        const MAX_RETRIES = 5;
        // Contention is SUSTAINED, not a one-off. An earlier version of this
        // model let every interleaved buyer commit during attempt 1 only, which
        // meant the retry could fail at most once and then always succeeded —
        // making the retry-limit branch below UNREACHABLE. That is dead code
        // dressed as defensive programming, and a reachability probe over every
        // stock/buyer shape confirmed it never fired.
        //
        // One interleaved buyer commits per attempt instead. That is both more
        // faithful — a busy row stays busy — and it makes exhaustion something
        // the tests can actually reach.
        const contenders = [...(buyer.interleavedBy ?? [])];

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          const { stock, version } = row.read();
          if (stock <= 0) {
            return {
              buyer: buyer.id,
              sold: false,
              reason: "sold out",
              attempts: attempt,
            };
          }

          const otherId = contenders.shift();
          if (otherId !== undefined && !consumed.has(otherId)) {
            consumed.add(otherId);
            const won = row.decrementIfPositive();
            outcomes.push({
              buyer: otherId,
              sold: won === 1,
              reason: won === 1 ? "sold (interleaved)" : "sold out",
              attempts: 1,
            });
          }

          // Fails if the version moved — which is exactly what the interleaved
          // buyers above just did.
          if (row.writeIfVersion(version, stock - 1) === 1) {
            return {
              buyer: buyer.id,
              sold: true,
              reason: attempt === 1 ? "sold" : `sold after ${attempt - 1} retries`,
              attempts: attempt,
            };
          }
          totalRetries++;
        }

        // Giving up is a REFUSAL, never a sale. Retry exhaustion must not be
        // allowed to become an oversell.
        return {
          buyer: buyer.id,
          sold: false,
          reason: "retry limit reached",
          attempts: MAX_RETRIES,
        };
      }
    }
  };

  for (const buyer of buyers) {
    if (consumed.has(buyer.id)) continue;
    consumed.add(buyer.id);
    outcomes.push(buy(buyer));
  }

  const sold = outcomes.filter((o) => o.sold).length;
  return {
    strategy,
    initialStock,
    sold,
    refused: outcomes.length - sold,
    // Not derived from the counter the strategy kept — derived from the OUTCOMES.
    // A strategy that miscounts its own sales must not be able to report zero.
    oversold: Math.max(0, sold - initialStock),
    totalRetries,
    remainingStock: row.current,
    outcomes,
  };
}
