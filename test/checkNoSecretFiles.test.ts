import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Tests the guard by RUNNING it, against throwaway repositories built here.
 *
 * Importing the module and calling `check()` would test a function; CI runs a
 * file. This project has been burned by that gap before — a middleware test
 * imported the module directly and passed for months against code the
 * framework never loaded. So this spawns `node scripts/check-no-secret-files.mjs`
 * exactly as the CI step does, and asserts on its exit code and its output.
 *
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` are neutralised for every fixture.
 * Without that the result depends on whose laptop is running: this developer's
 * `~/.gitignore_global` ignores `.env` everywhere, which is precisely the
 * false sense of safety the guard exists to refuse.
 */

const GUARD = path.resolve(process.cwd(), "scripts/check-no-secret-files.mjs");

const SAFE_GITIGNORE = [
  ".env*",
  "!.env.example",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials.json",
  "serviceAccount*.json",
  "service-account*.json",
  "",
].join("\n");

type Fixture = { dir: string; env: Record<string, string | undefined> };

function makeRepo(files: Record<string, string>): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "secretguard-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  execFileSync("git", ["init", "-q"], { cwd: dir, env });
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  // Staged is enough: `git ls-files` reads the index, and the failure this
  // guards against is the file entering the index in the first place.
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  return { dir, env };
}

function run(repo: Fixture) {
  try {
    const stdout = execFileSync("node", [GUARD], {
      cwd: repo.dir,
      env: repo.env,
      encoding: "utf8",
    });
    return { code: 0, out: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("check-no-secret-files", () => {
  it("passes a repo whose own .gitignore covers the sensitive names", () => {
    const repo = makeRepo({
      ".gitignore": SAFE_GITIGNORE,
      "package.json": "{}\n",
      ".env.example": "API_KEY=\n",
    });
    const { code, out } = run(repo);
    expect(out).not.toMatch(/FAILED/);
    expect(code).toBe(0);
  });

  it("fails, and names the file, when a .env is staged", () => {
    const repo = makeRepo({
      ".gitignore": SAFE_GITIGNORE,
      "package.json": "{}\n",
      "config/.env": "SECRET=hunter2\n",
    });
    // Force it past the ignore rule, the way `git add -f` or a rule added
    // after the fact would.
    execFileSync("git", ["add", "-f", "config/.env"], {
      cwd: repo.dir,
      env: repo.env,
    });
    const { code, out } = run(repo);
    expect(code).toBe(1);
    expect(out).toMatch(/tracked dotenv file: config\/\.env/);
  });

  it("fails when a private key is staged", () => {
    const repo = makeRepo({ "package.json": "{}\n" });
    writeFileSync(path.join(repo.dir, "server.key"), "-----BEGIN PRIVATE KEY-----\n");
    execFileSync("git", ["add", "-f", "server.key"], {
      cwd: repo.dir,
      env: repo.env,
    });
    const { code, out } = run(repo);
    expect(code).toBe(1);
    expect(out).toMatch(/tracked key file: server\.key/);
  });

  it("fails when the only thing ignoring .env is .git/info/exclude", () => {
    // The regression that motivated the guard's shape. An exclude file inside
    // .git protects this checkout and nothing else: not CI, not a clone, not a
    // second machine. A guard that merely asked "is it ignored" would pass here
    // and let the first .env through from anywhere else.
    const repo = makeRepo({ "package.json": "{}\n" });
    writeFileSync(path.join(repo.dir, ".git/info/exclude"), ".env\n");
    const { code, out } = run(repo);
    expect(code).toBe(1);
    expect(out).toMatch(/no committed ignore rule covers it.*\.env/s);
  });

  it("does not object to a committed .env.example", () => {
    const repo = makeRepo({
      ".gitignore": SAFE_GITIGNORE,
      "package.json": "{}\n",
      ".env.example": "DATABASE_URL=\n",
    });
    const { code, out } = run(repo);
    expect(code).toBe(0);
    expect(out).not.toMatch(/\.env\.example/);
  });

  it("probes nested package directories, not just the root", () => {
    // A monorepo can be clean at the root and open one level down.
    const repo = makeRepo({
      ".gitignore": SAFE_GITIGNORE,
      "package.json": "{}\n",
      "Backend/package.json": "{}\n",
      "Backend/.gitignore": "!.env\n",
    });
    const { code, out } = run(repo);
    expect(code).toBe(1);
    expect(out).toMatch(/Backend\/\.env/);
  });

  it("is satisfied by this repository itself", () => {
    const { code, out } = run({ dir: process.cwd(), env: process.env });
    expect(out).not.toMatch(/FAILED/);
    expect(code).toBe(0);
  });
});
