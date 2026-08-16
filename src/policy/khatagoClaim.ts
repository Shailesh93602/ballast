/**
 * KhataGO's webhook claim protocol, modelled.
 *
 * This is not a toy inspired by KhataGO — it is that system's actual mechanism,
 * one layer down, so the checker built for BALLAST can be pointed at real
 * production logic without being rewritten.
 *
 * The real thing (`app/api/whatsapp/route.ts`, `prisma/schema.prisma:36`):
 *
 *   1. Meta delivers a webhook AT LEAST ONCE — redelivery on a slow response is
 *      documented behaviour, not an edge case.
 *   2. `persistWhatsappMessage` inserts with `waMessageId String? @unique`, so a
 *      duplicate insert FAILS AT THE DATABASE rather than being prevented by a
 *      read-then-write check that can interleave.
 *   3. The handler acks Meta immediately and runs the Gemini work after the
 *      response, so a burst never times out the webhook and triggers the
 *      redelivery storm the design is trying to avoid.
 *   4. `processWhatsappMessage` atomically claims the row by flipping
 *      `aiStatus PENDING -> PROCESSING` in one conditional UPDATE. Zero rows
 *      changed means another delivery already claimed it, so this one exits.
 *
 * The claim is the same shape as BALLAST's admission: a predicate evaluated
 * INSIDE the mutation rather than before it. That is why the same invariants
 * apply, and why I8 — exactly one effect per identity — is the one that carries
 * the weight here.
 *
 * WHAT THIS MODEL DELIBERATELY DOES NOT CLAIM: it is a model. Running it proves
 * the protocol is sound, not that KhataGO's Prisma calls implement the protocol
 * faithfully. Tier B drives the real handler against a local Postgres and runs
 * this same checker over the recorded history; that is what closes the gap, and
 * until it runs the honest claim is "verified in simulation".
 */

export type AiStatus = "PENDING" | "PROCESSING" | "DONE" | "FAILED";

export interface StoredMessage {
  readonly waMessageId: string;
  aiStatus: AiStatus;
  /** How many times the AI pipeline actually ran for this message. */
  effectRuns: number;
  /** Set when the ledger write is durably committed. */
  committed: boolean;
}

export interface DeliveryOutcome {
  readonly stored: boolean;
  readonly claimed: boolean;
  readonly ackStatus: 202 | 200 | 500;
  readonly reason: string;
}

export class KhataGoClaimModel {
  /** Stands in for the table with the unique constraint on waMessageId. */
  private readonly rows = new Map<string, StoredMessage>();
  private duplicateInserts = 0;
  private lostClaims = 0;

  get messages(): ReadonlyMap<string, StoredMessage> {
    return this.rows;
  }

  get stats() {
    return { duplicateInserts: this.duplicateInserts, lostClaims: this.lostClaims };
  }

  /** I8's input: identity -> how many times the effect ran. */
  effectCounts(): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (const [id, row] of this.rows) out.set(id, row.effectRuns);
    return out;
  }

  /**
   * Step 2 — insert, deduped by the unique constraint.
   *
   * Modelled as the DATABASE refusing the duplicate, not as an application-level
   * `findUnique` followed by `create`. That distinction is the entire point: a
   * read-then-write can interleave between the read and the write, and two
   * concurrent deliveries both see "not present" and both insert. The real
   * system had exactly this bug on the ack path — the losers hit P2002 and
   * returned 500, and Meta treats non-2xx as undelivered and redelivers.
   */
  persist(waMessageId: string): { inserted: boolean; row: StoredMessage } {
    const existing = this.rows.get(waMessageId);
    if (existing !== undefined) {
      this.duplicateInserts++;
      // Converge on the winner's row rather than erroring. Returning a 500 here
      // is what turned a handled duplicate into a redelivery loop.
      return { inserted: false, row: existing };
    }
    const row: StoredMessage = {
      waMessageId,
      aiStatus: "PENDING",
      effectRuns: 0,
      committed: false,
    };
    this.rows.set(waMessageId, row);
    return { inserted: true, row };
  }

  /**
   * Step 4 — the atomic claim.
   *
   * `UPDATE ... SET aiStatus='PROCESSING' WHERE id=? AND aiStatus='PENDING'`.
   * The predicate is part of the write. Returns false when zero rows changed,
   * which means someone else won.
   */
  claim(waMessageId: string): boolean {
    const row = this.rows.get(waMessageId);
    if (row === undefined) return false;
    if (row.aiStatus !== "PENDING") {
      this.lostClaims++;
      return false;
    }
    row.aiStatus = "PROCESSING";
    return true;
  }

  /**
   * Run the effect and commit, as ONE unit.
   *
   * `podDied` models the worker dying between winning the claim and committing —
   * the case that decides whether the protocol leaks. The row stays PROCESSING,
   * so the message is neither done nor reclaimable, which is the honest
   * behaviour of the real system and the reason a reaper would be needed in
   * production.
   */
  runEffect(waMessageId: string, podDied: boolean): boolean {
    const row = this.rows.get(waMessageId);
    if (row === undefined) return false;
    if (row.aiStatus !== "PROCESSING") return false;
    if (podDied) return false; // stuck in PROCESSING — see the note above
    row.effectRuns++;
    row.committed = true;
    row.aiStatus = "DONE";
    return true;
  }

  /** One full delivery: persist, ack, then claim-and-process. */
  deliver(waMessageId: string, podDied = false): DeliveryOutcome {
    const { inserted } = this.persist(waMessageId);

    // Ack Meta immediately — 202 whether or not this delivery was the first.
    // A duplicate is a successful no-op, not an error.
    const won = this.claim(waMessageId);
    if (!won) {
      return {
        stored: inserted,
        claimed: false,
        ackStatus: 202,
        reason: inserted ? "stored-but-lost-claim" : "duplicate-delivery",
      };
    }
    this.runEffect(waMessageId, podDied);
    return { stored: inserted, claimed: true, ackStatus: 202, reason: "processed" };
  }
}
