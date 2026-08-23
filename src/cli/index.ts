#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { replayTrace } from "../core/replay.js";
import { DEFAULT_CONFIG, runSimulation, NaivePolicy } from "../core/simulate.js";

/**
 * `ballast` CLI.
 *
 * Exempt from the determinism ban list (it does real file I/O), so it stays a
 * thin shell: parse, call into core, print. No decisions are made here.
 */

interface Args {
  readonly command: string;
  readonly seed: number;
  readonly out: string | undefined;
  readonly hashOnly: boolean;
  readonly trace: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const [command = "help"] = argv;
  let seed = 1;
  let out: string | undefined;
  let hashOnly = false;
  let trace: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--seed") {
      const raw = argv[++i];
      if (raw === undefined) throw new Error("--seed requires a value");
      const parsed = Number(raw);
      if (!Number.isInteger(parsed))
        throw new Error(`--seed must be an integer, got ${raw}`);
      seed = parsed;
    } else if (flag === "--out") {
      out = argv[++i];
    } else if (flag === "--hash-only") {
      hashOnly = true;
    } else if (flag === "--trace") {
      trace = argv[++i];
      if (trace === undefined) throw new Error("--trace requires a path");
    }
  }
  return { command, seed, out, hashOnly, trace };
}

function usage(): void {
  console.log(
    [
      "ballast — deterministic simulation of a multi-tenant session control plane",
      "",
      "  ballast simulate --seed N [--out log.jsonl] [--hash-only]",
      "      Run one simulation. Prints the decision-log hash.",
      "",
      "  ballast replay --trace log.jsonl",
      "      Re-check a RECORDED trace. Seedless, offline, and independent of",
      "      the current source — so a shrunk failure stays reproducible across",
      "      the very edits you are making to fix it.",
      "",
      "  ballast help",
      "",
      "Every run of the same seed produces a byte-identical decision log.",
      "See docs/DETERMINISM.md for what that guarantee rests on.",
    ].join("\n"),
  );
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help" || args.command === "--help") {
    usage();
    return 0;
  }

  if (args.command === "replay") {
    if (args.trace === undefined) {
      console.error("replay requires --trace <path>");
      return 2;
    }

    const report = replayTrace(readFileSync(args.trace, "utf8"));

    console.log(`records     ${report.records}`);
    console.log(`tenants     ${report.tenants.join(", ") || "(none)"}`);
    for (const [kind, count] of [...report.kindCounts].sort()) {
      console.log(`  ${kind.padEnd(16)}${count}`);
    }

    if (report.problems.length === 0) {
      console.log("\nstructure   OK");
      return 0;
    }

    // Non-zero exit, so this is usable as a gate rather than only as a report.
    console.error(`\n${report.problems.length} structural problem(s):`);
    for (const problem of report.problems) {
      console.error(`  seq ${problem.seq}: ${problem.message}`);
    }
    return 1;
  }

  if (args.command === "simulate") {
    const result = runSimulation(
      { ...DEFAULT_CONFIG, seed: args.seed },
      new NaivePolicy(4),
    );
    const hash = result.log.hash();
    if (args.hashOnly) {
      console.log(hash);
      return 0;
    }
    if (args.out !== undefined) {
      writeFileSync(args.out, result.log.toJsonl() + "\n", "utf8");
    }
    console.log(`seed        ${args.seed}`);
    console.log(`events      ${result.eventsProcessed}`);
    console.log(`decisions   ${result.log.length}`);
    console.log(`final tick  ${result.finalTime}`);
    console.log(`hash        ${hash}`);
    if (args.out !== undefined) console.log(`wrote       ${args.out}`);
    return 0;
  }

  console.error(`unknown command: ${args.command}`);
  usage();
  return 2;
}

process.exit(main());
