import { describe, expect, it } from "vitest";

import {
  REQUIRED_DATABASE,
  UnsafeDatabaseError,
  assertConnectedToSafeDatabase,
  assertSafeDatabaseUrl,
} from "../src/tierb/safety.js";

const SAFE = `postgresql://localhost:5432/${REQUIRED_DATABASE}`;

describe("Tier B safety gate", () => {
  it("accepts the local throwaway database", () => {
    const verdict = assertSafeDatabaseUrl(SAFE);
    expect(verdict).toEqual({
      safe: true,
      host: "localhost",
      database: REQUIRED_DATABASE,
    });
  });

  it("accepts the loopback IP forms", () => {
    for (const host of ["127.0.0.1", "[::1]"]) {
      expect(() =>
        assertSafeDatabaseUrl(`postgresql://${host}:5432/${REQUIRED_DATABASE}`),
      ).not.toThrow();
    }
  });

  // THE TEST THIS FILE EXISTS FOR.
  //
  // KhataGO's DATABASE_URL points at production Supabase. Tier B injects
  // duplicate and out-of-order deliveries; pointed at production that is not a
  // test, it is an incident.
  it("refuses a remote host, however plausible", () => {
    const remotes = [
      "postgresql://user:pw@db.abcdefgh.supabase.co:5432/postgres",
      "postgresql://user:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
      `postgresql://user:pw@db.example.com:5432/${REQUIRED_DATABASE}`,
      // Local database NAME but remote host — the near-miss that a
      // name-only check would wave through.
      `postgresql://user:pw@10.0.0.5:5432/${REQUIRED_DATABASE}`,
    ];

    for (const url of remotes) {
      expect(() => assertSafeDatabaseUrl(url), url).toThrow(UnsafeDatabaseError);
    }
  });

  it("refuses a local host with the wrong database", () => {
    // `khatago` is the real local dev database and has real data in it.
    // `khatago_ballast_backup` is the prefix near-miss.
    for (const db of ["khatago", "khatago_e2e", "postgres", "khatago_ballast_backup"]) {
      expect(
        () => assertSafeDatabaseUrl(`postgresql://localhost:5432/${db}`),
        db,
      ).toThrow(UnsafeDatabaseError);
    }
  });

  it("refuses an unset, empty or unparseable URL", () => {
    for (const url of [undefined, "", "   ", "not a url", "://broken"]) {
      expect(() => assertSafeDatabaseUrl(url), String(url)).toThrow(UnsafeDatabaseError);
    }
  });

  it("refuses a non-Postgres protocol", () => {
    expect(() =>
      assertSafeDatabaseUrl(`mysql://localhost:3306/${REQUIRED_DATABASE}`),
    ).toThrow(UnsafeDatabaseError);
  });

  it("refuses a local URL carrying superuser credentials", () => {
    // A half-finished copy-paste from a production URL. The host and database
    // were edited; the credentials were not.
    expect(() =>
      assertSafeDatabaseUrl(
        `postgresql://postgres:realpassword@localhost:5432/${REQUIRED_DATABASE}`,
      ),
    ).toThrow(UnsafeDatabaseError);
  });

  it("explains WHY it refused, so nobody disables it to make progress", () => {
    try {
      assertSafeDatabaseUrl("postgresql://db.abcdefgh.supabase.co:5432/postgres");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("db.abcdefgh.supabase.co");
      expect((error as Error).message).toContain("not local");
    }
  });
});

describe("post-connection verification", () => {
  // The check that would have caught the real incident: the URL passed
  // validation, and the client connected somewhere else entirely.
  it("catches a client that resolved a different database than the validated URL", () => {
    expect(() =>
      assertConnectedToSafeDatabase({
        database: "postgres",
        host: "aws-1-ap-southeast-2.pooler.supabase.com",
      }),
    ).toThrow(UnsafeDatabaseError);
  });

  it("catches the right database name on a remote host", () => {
    expect(() =>
      assertConnectedToSafeDatabase({
        database: REQUIRED_DATABASE,
        host: "10.0.0.5",
      }),
    ).toThrow(UnsafeDatabaseError);
  });

  it("accepts the real local database", () => {
    expect(() =>
      assertConnectedToSafeDatabase({
        database: REQUIRED_DATABASE,
        host: "localhost",
      }),
    ).not.toThrow();
  });

  it("accepts a unix-socket connection, which reports no host", () => {
    // psql connecting over /tmp reports null. Local by definition.
    expect(() =>
      assertConnectedToSafeDatabase({ database: REQUIRED_DATABASE, host: null }),
    ).not.toThrow();
  });

  it("names the database it actually reached, so the mistake is diagnosable", () => {
    try {
      assertConnectedToSafeDatabase({ database: "postgres", host: "localhost" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain('"postgres"');
      expect((error as Error).message).toContain("resolved a different URL");
    }
  });
});
