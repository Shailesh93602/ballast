#!/usr/bin/env node
/**
 * Refuses to let a credential-bearing file into git.
 *
 * Why this exists
 * ---------------
 * A sibling repo committed `.env` files years ago. The history was rewritten
 * and force-pushed, which removed them from every clone, from blame and from
 * code search — and did NOT remove them from GitHub, because `refs/pull/*` is
 * server-side and cannot be force-pushed or deleted. A fresh anonymous clone
 * still reached them. Twenty-three variables were exposed and nobody knew,
 * because nothing ever asked the question.
 *
 * Deleting a secret from a repository is expensive and, on a public repo,
 * never fully succeeds. Not adding one is free. So this runs in CI.
 *
 * It makes two assertions, and the second is the one that matters
 * ---------------------------------------------------------------
 *  1. No tracked file is credential-bearing by name.  Catches today.
 *  2. The repo's ignore rules actually stop such a file from being added.
 *     Catches tomorrow.
 *
 * (2) is deliberately not "grep .gitignore for `.env`". A pattern list read
 * off a file is a claim about behaviour; `git check-ignore` is the behaviour.
 * They come apart constantly — a nested .gitignore that re-includes, a rule
 * that only matches at the root, an `.env` rule that does not cover
 * `.env.production`. So this asks git, per probe path, per package directory.
 *
 * A negative control runs too: `.env.example` must NOT be ignored. A repo that
 * ignores it has quietly lost the one env file it is supposed to commit, and a
 * blanket `.env*` with no re-include looks correct right up until someone
 * wonders where the example went.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Names that carry credentials often enough to be refused by default. */
const SENSITIVE = [
  { label: "dotenv file", re: /(^|\/)\.env(\.|$)/ },
  { label: "PEM / private key", re: /\.(pem|p12|pfx|jks|keystore)$/i },
  { label: "key file", re: /\.key$/i },
  { label: "SSH private key", re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/ },
  { label: "cloud credentials", re: /(^|\/)credentials\.json$/i },
  { label: "GCP service account", re: /(^|\/)service[-_]?account[^/]*\.json$/i },
];

/**
 * Suffixes that make a sensitive-looking name safe to commit.
 *
 * Worth stating plainly: this is a claim about intent, not about content. An
 * `.example` file CAN hold a real secret — one in this project's history did,
 * carrying a live Cloudinary API secret under the name `env.example.md`. The
 * suffix buys the file past the name check and nothing more; the content
 * scanner is what covers that case.
 */
const PLACEHOLDER_SUFFIXES = [".example", ".sample", ".template", ".dist"];

/** Probe names asked of `git check-ignore`. Must all be ignored. */
const MUST_BE_IGNORED = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".env.prod.local",
  "id_rsa",
  "private.pem",
  "server.key",
  "credentials.json",
  "serviceAccount.json",
];

/** Must NOT be ignored — see the negative-control note above. */
const MUST_NOT_BE_IGNORED = [".env.example"];

function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: opts.cwd ?? process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * True only when a COMMITTED ignore rule covers `relPath`.
 *
 * The distinction is the whole point. A developer machine can carry a global
 * excludes file (`core.excludesFile`) or a repo-local `.git/info/exclude`, and
 * neither travels: not to CI, not to a fresh clone, not to a second machine.
 * This project has exactly that setup — `~/.gitignore_global` ignores `.env`
 * everywhere — which made a repo with no env rule of its own look protected
 * when asked locally, and would have let the first `.env` straight in from any
 * other checkout.
 *
 * So the answer is not "is it ignored here". `git check-ignore -v` names the
 * file and line that decided, and only a source path inside the working tree
 * (and not under .git/) is a rule that ships with the repository.
 */
function ignoredByCommittedRule(repo, relPath) {
  let out;
  try {
    out = execFileSync("git", ["check-ignore", "-v", "--", relPath], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // 1 = no rule matched at all. Anything else is a real failure.
    if (err.status === 1) return false;
    throw err;
  }
  // `<source>:<line>:<pattern>\t<pathname>`.
  const decision = out.split("\t")[0];
  const m = /^(.*):(\d+):(.*)$/.exec(decision);
  if (!m) return false;
  const [, source, , pattern] = m;

  // With -v, git exits 0 whenever a pattern MATCHED — including a negation,
  // which means the opposite of ignored. Read the pattern, not the exit code.
  // (Without -v the exit code is the answer, but then there is no source to
  // check, and the source is the whole point.)
  if (pattern.startsWith("!")) return false;

  if (path.isAbsolute(source)) return false; // global excludes file
  if (source.startsWith(".git/")) return false; // .git/info/exclude
  return true;
}

function trackedFiles(repo) {
  return git(["ls-files", "-z"], { cwd: repo }).split("\0").filter(Boolean);
}

/**
 * Directories a probe is run in: the repo root plus every directory holding a
 * package.json. A monorepo can ignore `.env` at the root and still let one in
 * under `Backend/` if a nested .gitignore re-includes; only asking per package
 * directory catches that.
 */
function probeDirs(repo) {
  const dirs = new Set(["."]);
  for (const f of trackedFiles(repo)) {
    if (path.basename(f) !== "package.json") continue;
    const d = path.dirname(f);
    if (d.split("/").length <= 2 && !d.includes("node_modules")) dirs.add(d);
  }
  return [...dirs];
}

export function classify(file) {
  if (PLACEHOLDER_SUFFIXES.some((s) => file.endsWith(s))) return null;
  return SENSITIVE.find((p) => p.re.test(file))?.label ?? null;
}

export function check(repo = process.cwd()) {
  const problems = [];

  for (const f of trackedFiles(repo)) {
    const label = classify(f);
    if (label) problems.push(`tracked ${label}: ${f}`);
  }

  for (const dir of probeDirs(repo)) {
    for (const name of MUST_BE_IGNORED) {
      const rel = dir === "." ? name : `${dir}/${name}`;
      if (!ignoredByCommittedRule(repo, rel)) {
        problems.push(
          `no committed ignore rule covers it, so nothing stops it being committed: ${rel}`,
        );
      }
    }
    for (const name of MUST_NOT_BE_IGNORED) {
      const rel = dir === "." ? name : `${dir}/${name}`;
      // Only a complaint where the example file is actually meant to live.
      if (existsSync(path.join(repo, rel)) && ignoredByCommittedRule(repo, rel)) {
        problems.push(`ignored but exists and is meant to be committed: ${rel}`);
      }
    }
  }

  return problems;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (invokedDirectly) {
  const problems = check(process.cwd());
  if (problems.length === 0) {
    console.log(
      "check-no-secret-files: OK — nothing credential-bearing is tracked, and the ignore rules hold.",
    );
    process.exit(0);
  }
  console.error("check-no-secret-files: FAILED\n");
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    "\nA secret pushed to a public repo cannot be fully withdrawn: refs/pull/* survives a history rewrite.\nMove the value into the deployment environment and commit only a placeholder example file.",
  );
  process.exit(1);
}
