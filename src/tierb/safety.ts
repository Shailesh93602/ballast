/**
 * Safety gate for Tier B.
 *
 * Tier B drives the REAL KhataGO handler against a REAL Postgres. That is the
 * whole point of it, and it is also the only part of BALLAST that can destroy
 * something. KhataGO's DATABASE_URL points at production Supabase (its
 * CLAUDE.md says so), and the fault injection here deliberately includes
 * duplicate and out-of-order deliveries — exactly the traffic you least want
 * pointed at real customer data.
 *
 * So this module refuses to let the harness connect to anything that is not an
 * obviously-local throwaway. It is written and tested BEFORE the first
 * connection, on purpose: a safety check added after the first successful run
 * has already failed at its job once.
 *
 * The rule is allow-list, not deny-list. A deny-list of "things that look like
 * production" is a guess about the shape of a hostname; an allow-list is a
 * statement about what we are willing to touch.
 */

export class UnsafeDatabaseError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to connect: ${reason}. Tier B only runs against a local throwaway database.`,
    );
    this.name = "UnsafeDatabaseError";
  }
}

/** The only database name Tier B will ever touch. */
export const REQUIRED_DATABASE = "khatago_ballast";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface SafetyVerdict {
  readonly safe: true;
  readonly host: string;
  readonly database: string;
}

/**
 * Throws unless `url` is unambiguously a local throwaway database.
 *
 * Every rejection names its reason, because a safety gate that fails with
 * "invalid" teaches the operator nothing and gets disabled.
 */
export function assertSafeDatabaseUrl(url: string | undefined): SafetyVerdict {
  if (!url || url.trim() === "") {
    throw new UnsafeDatabaseError("DATABASE_URL is not set");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeDatabaseError("DATABASE_URL is not a parseable URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new UnsafeDatabaseError(`protocol ${parsed.protocol} is not Postgres`);
  }

  // Hostname must be local. This is the check that keeps us off Supabase.
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new UnsafeDatabaseError(`host ${parsed.hostname} is not local`);
  }

  // Database name must be the exact throwaway. Not "starts with", not
  // "contains" — `khatago_ballast_backup` is not this database, and neither is
  // the real `khatago`.
  const database = parsed.pathname.replace(/^\//, "");
  if (database !== REQUIRED_DATABASE) {
    throw new UnsafeDatabaseError(`database "${database}" is not "${REQUIRED_DATABASE}"`);
  }

  // A local URL carrying production-looking credentials is a copy-paste that
  // went half-way. Treat it as a mistake rather than as harmless.
  if (parsed.username === "postgres" && parsed.password !== "") {
    throw new UnsafeDatabaseError(
      "a password is set for the postgres superuser; this looks like a pasted production URL",
    );
  }

  return { safe: true, host: parsed.hostname, database };
}

/**
 * Verify, AFTER connecting, that we are actually where we think we are.
 *
 * 🔴 This exists because the pre-flight check alone was not enough, and I found
 * that out the expensive way.
 *
 * `assertSafeDatabaseUrl` validates a string. It says nothing about which
 * database the client actually opened. Running
 *
 *     DATABASE_URL="postgresql://localhost:5432/khatago_ballast" prisma migrate deploy
 *
 * in the KhataGO repo connects to **production Supabase**, because the Prisma
 * CLI loads the repo's .env and that value wins over the one exported in the
 * shell. The command announces "Environment variables loaded from .env" and
 * then does something entirely different from what the command line says.
 *
 * Nothing was harmed — production was already at every migration, so
 * `migrate deploy` applied nothing, and it is a command that never resets or
 * drops. But it was safe by luck, not by construction.
 *
 * The generalisable rule: **validate the string, then ask the connection what
 * it actually is.** Any tool that can silently substitute configuration defeats
 * a pre-flight check, and the only thing that does not lie is the live session.
 */
export function assertConnectedToSafeDatabase(actual: {
  database: string;
  host: string | null;
}): void {
  if (actual.database !== REQUIRED_DATABASE) {
    throw new UnsafeDatabaseError(
      `connected to database "${actual.database}", expected "${REQUIRED_DATABASE}" — ` +
        `the client resolved a different URL than the one that was validated`,
    );
  }

  // A unix-socket connection reports a null host; that is local by definition.
  if (actual.host !== null && !LOCAL_HOSTS.has(actual.host)) {
    throw new UnsafeDatabaseError(
      `connected to host "${actual.host}", which is not local`,
    );
  }
}
