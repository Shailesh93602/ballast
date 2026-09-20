import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import {
  DEFAULT_CONTROL_PLANE,
  REJECTION_PRECEDENCE,
  type ControlPlaneConfig,
  type RejectReason,
} from "../src/policy/types.js";
import {
  applyEvent,
  creditsInWindow,
  emptyWorld,
  referenceCreditsSpent,
  referenceRefusals,
  resolveByPrecedence,
  type RefEvent,
} from "../src/oracle/reference.js";
import { Rng } from "../src/core/rng.js";
import { DrivenPlane } from "./support/planeHarness.js";

/**
 * REJECTION-PRECEDENCE — SEMANTICS B7.
 *
 * The question this file exists for: when two refusal conditions hold at once,
 * which one does the caller hear about?
 *
 * Nothing said. B3 and B4 each name the reason that applies when ONE condition
 * holds; neither fixes an order. Both engines evaluated cap → credit → pool
 * because one author wrote both in one sitting, and the differential compares
 * the rejection REASON — so the question looked answered while both halves were
 * reading the same unwritten decision. That is the shared-spec blind spot in
 * its purest remaining form, and a differential cannot close it, because the
 * differential is the thing being fooled.
 *
 * What closes it is making the two engines derive the order from sources that
 * cannot silently agree:
 *
 *   the SPEC          docs/SEMANTICS.md B7, a numbered list, parsed below
 *   the CONSTANT      `REJECTION_PRECEDENCE`, asserted against the spec
 *   the REFERENCE     evaluates every condition, resolves through the constant
 *   the IMPLEMENTATION short-circuits in its own source order, unchanged
 *
 * Edit the implementation's order and the reference disagrees. Edit the
 * constant and the spec disagrees. Edit the spec and the constant disagrees.
 * There is no single edit that moves both halves quietly.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** The order as DECLARED, parsed out of SEMANTICS.md rather than restated. */
function declaredPrecedence(): string[] {
  const doc = readFileSync(join(root, "docs", "SEMANTICS.md"), "utf8");
  const section = /### B7 ·[\s\S]*?\n(?=### |\n---)/.exec(doc);
  if (section === null) throw new Error("SEMANTICS.md has no B7 row");
  return [...section[0].matchAll(/^\d+\.\s+`([a-z-]+)`\s*$/gm)].map(
    (m) => m[1] as string,
  );
}

describe("the declared order and the constant cannot drift apart", () => {
  it("REJECTION_PRECEDENCE is exactly the order SEMANTICS B7 declares", () => {
    expect(
      [...REJECTION_PRECEDENCE],
      "the constant the reference resolves through must match the spec row",
    ).toEqual(declaredPrecedence());
  });

  it("the declared order is not empty — a regex that matches nothing proves nothing", () => {
    // The guard's own vacuity check. If the B7 heading or the list formatting
    // changes, the parse silently returns [] and the assertion above compares
    // two empty arrays — green, and checking nothing.
    expect(declaredPrecedence().length).toBeGreaterThan(3);
  });

  it("every RejectReason has a declared precedence", () => {
    // A new reason added to the union without a row here would be resolvable
    // only by accident of evaluation order — exactly the state B7 fixes.
    const declared = new Set<string>(REJECTION_PRECEDENCE);
    const union = [
      ...readFileSync(join(root, "src", "policy", "types.ts"), "utf8").matchAll(
        /^\s*\|\s*"([a-z-]+)"$/gm,
      ),
    ].map((m) => m[1] as string);
    const rejectReasons = union.filter((u) => declared.has(u) || /-|^no/.test(u));
    const missing = rejectReasons.filter((r) => !declared.has(r));
    expect(missing, "RejectReason values with no declared precedence").toEqual([]);
  });
});

/**
 * Scenarios that CONSTRUCT each overlap.
 *
 * A precedence test run over a corpus that never produces two simultaneous
 * conditions is vacuous in exactly the way L13 was: it reports coverage of a
 * regime it never enters. So each scenario states the set it is supposed to
 * build, and the test asserts the reference really does report that set before
 * it asserts anything about the order.
 */
interface Scenario {
  readonly name: string;
  readonly expect: readonly RejectReason[];
  build(): { d: DrivenPlane; vtime: number; tenant: string; runId: string };
}

const tight = (
  cap: number,
  credits: number,
  pool: number,
  extra: Partial<ControlPlaneConfig> = {},
): ControlPlaneConfig => ({
  ...DEFAULT_CONTROL_PLANE,
  tenants: [{ id: "solo", cap, creditsPerWindow: credits }],
  poolCapacity: pool,
  ...extra,
});

const SCENARIOS: Scenario[] = [
  {
    name: "cap + credit",
    expect: ["cap-exceeded", "no-credit"],
    build() {
      const d = new DrivenPlane(tight(1, 1, 4));
      d.admit(0, "solo", "r1");
      return { d, vtime: 1, tenant: "solo", runId: "r2" };
    },
  },
  {
    name: "cap + pool",
    expect: ["cap-exceeded", "pool-full"],
    build() {
      const d = new DrivenPlane(tight(1, 50, 1));
      d.admit(0, "solo", "r1");
      return { d, vtime: 1, tenant: "solo", runId: "r2" };
    },
  },
  {
    name: "credit + pool",
    expect: ["no-credit", "pool-full"],
    build() {
      const d = new DrivenPlane(tight(5, 1, 1));
      d.admit(0, "solo", "r1");
      return { d, vtime: 1, tenant: "solo", runId: "r2" };
    },
  },
  {
    name: "cap + credit + pool",
    expect: ["cap-exceeded", "no-credit", "pool-full"],
    build() {
      const d = new DrivenPlane(tight(1, 1, 1));
      d.admit(0, "solo", "r1");
      return { d, vtime: 1, tenant: "solo", runId: "r2" };
    },
  },
  {
    name: "unknown-tenant + cancelled-before-start",
    expect: ["unknown-tenant", "cancelled-before-start"],
    build() {
      // THE DIVERGENCE THE TWO ENGINES ALREADY HAD. The implementation looks
      // the tenant up first and answers `unknown-tenant`; the reference
      // checked the lifecycle first and answered `cancelled-before-start`.
      // Every corpus draws its tenants from the configured list, so no
      // generated history has ever contained this request (LEDGER L23).
      const d = new DrivenPlane(DEFAULT_CONTROL_PLANE);
      d.cancel(0, "x");
      return { d, vtime: 1, tenant: "ghost", runId: "x" };
    },
  },
  {
    name: "unknown-tenant + run-already-terminal",
    expect: ["unknown-tenant", "run-already-terminal"],
    build() {
      const d = new DrivenPlane(DEFAULT_CONTROL_PLANE);
      d.admit(0, "acme", "x");
      d.complete(1, "x");
      return { d, vtime: 2, tenant: "ghost", runId: "x" };
    },
  },
  {
    name: "unknown-tenant + pool-full",
    expect: ["unknown-tenant", "pool-full"],
    build() {
      const d = new DrivenPlane({ ...DEFAULT_CONTROL_PLANE, poolCapacity: 1 });
      d.admit(0, "acme", "r1");
      return { d, vtime: 1, tenant: "ghost", runId: "fresh" };
    },
  },
  {
    name: "cancelled-before-start + cap-exceeded",
    expect: ["cancelled-before-start", "cap-exceeded"],
    build() {
      const d = new DrivenPlane(tight(1, 50, 4));
      d.cancel(0, "x");
      d.admit(0, "solo", "filler");
      return { d, vtime: 1, tenant: "solo", runId: "x" };
    },
  },
  {
    name: "run-already-terminal + cap-exceeded",
    expect: ["run-already-terminal", "cap-exceeded"],
    build() {
      const d = new DrivenPlane(tight(1, 50, 4));
      d.admit(0, "solo", "x");
      d.complete(1, "x");
      d.admit(2, "solo", "filler");
      return { d, vtime: 3, tenant: "solo", runId: "x" };
    },
  },
];

describe("precedence: the two engines are compared on overlapping refusals", () => {
  /**
   * ONE test over every scenario, not one test per scenario.
   *
   * `readmeClaims.test.ts` forbids an `it(` inside a loop, because the README's
   * test count is a static regex over the source and a loop writes one match
   * while running many — the counter would silently drift below the suite. That
   * guard is right, and the honest response is to collect rather than to loosen
   * it. Collecting is better here anyway: a divergence in the fourth scenario
   * should not hide the fifth.
   */
  it("every declared overlap is REACHED, and both engines resolve it the same way", () => {
    const unreached: string[] = [];
    const divergences: string[] = [];
    const notRefused: string[] = [];

    for (const sc of SCENARIOS) {
      const { d, vtime, tenant, runId } = sc.build();
      const history: RefEvent[] = [...d.history, { kind: "admit", vtime, tenant, runId }];
      const refusals = referenceRefusals(d.config, history, history.length - 1);

      // Non-vacuity FIRST: the scenario must actually build the overlap it
      // claims. An order assertion over a single-condition state says nothing,
      // and a scenario that silently stops constructing its overlap is the
      // L13 failure — coverage reported for a regime never entered.
      const got = [...refusals].sort().join("+");
      const want = [...sc.expect].sort().join("+");
      if (got !== want || refusals.length < 2) {
        unreached.push(`${sc.name}: built [${got}], expected [${want}]`);
        continue;
      }

      const outcome = d.admit(vtime, tenant, runId);
      if (outcome.ok) {
        notRefused.push(sc.name);
        continue;
      }
      const declared = resolveByPrecedence(refusals);
      if (outcome.reason !== declared) {
        divergences.push(
          `${sc.name}: implementation reports ${outcome.reason}, ` +
            `SEMANTICS B7 says ${declared}`,
        );
      }
    }

    expect(unreached, "scenarios that no longer construct their overlap").toEqual([]);
    expect(notRefused, "scenarios whose request was not refused at all").toEqual([]);
    expect(divergences, "implementation vs the declared precedence").toEqual([]);
    expect(SCENARIOS.length, "the scenario set must not be empty").toBeGreaterThan(5);
  });

  it("names the overlap it CANNOT reach rather than quietly counting it covered", () => {
    // `cancelled-before-start` and `run-already-terminal` cannot both hold —
    // status is one field. Their relative order is declared in B7 and is
    // structurally unobservable, which is a thing to say out loud rather than
    // leave for someone to discover when they trust the test.
    const reached = new Set(SCENARIOS.flatMap((s) => [...s.expect].sort().join("+")));
    expect(
      [...reached].some(
        (k) => k.includes("cancelled-before-start") && k.includes("run-already-terminal"),
      ),
      "if this pair ever becomes constructible, B7's note is wrong and this " +
        "test should start asserting it instead",
    ).toBe(false);

    // Whitespace-collapsed: prettier reflows prose, so an assertion that
    // depends on where a line happens to wrap fails for the wrong reason.
    const doc = readFileSync(join(root, "docs", "SEMANTICS.md"), "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(doc, "B7 must record the unreachable pair").toContain(
      "structurally unobservable",
    );
  });

  it("every ADJACENT pair in the declared order is exercised by some scenario", () => {
    // The order is a chain, and a chain is only pinned where two links are
    // compared. A scenario set that happens to skip a link leaves that part of
    // B7 asserted by nothing.
    const order = [...REJECTION_PRECEDENCE];
    const covered = new Set<string>();
    for (const sc of SCENARIOS) {
      for (const a of sc.expect) {
        for (const b of sc.expect) {
          if (order.indexOf(a) < order.indexOf(b)) covered.add(`${a}>${b}`);
        }
      }
    }
    const unreachable = new Set(["cancelled-before-start>run-already-terminal"]);
    const missing: string[] = [];
    for (let i = 0; i + 1 < order.length; i++) {
      const key = `${order[i]}>${order[i + 1]}`;
      if (!covered.has(key) && !unreachable.has(key)) missing.push(key);
    }
    expect(missing, "adjacent precedence pairs no scenario compares").toEqual([]);
  });
});

/** The same comparison, over the random corpus rather than hand-built states. */
function makeHistory(seed: number, length: number): RefEvent[] {
  const rng = new Rng(seed);
  const tenants = DEFAULT_CONTROL_PLANE.tenants.map((t) => t.id);
  const events: RefEvent[] = [];
  const live: string[] = [];
  let vtime = 0;
  let nextRun = 0;
  for (let i = 0; i < length; i++) {
    vtime += rng.nextInt(0, 4);
    const roll = rng.nextInt(0, 100);
    if (roll < 55 || live.length === 0) {
      const tenant = tenants[rng.nextInt(0, tenants.length)] as string;
      events.push({ kind: "admit", vtime, tenant, runId: `r${nextRun}` });
      live.push(`r${nextRun++}`);
    } else {
      const idx = rng.nextInt(0, live.length);
      const runId = live[idx] as string;
      live.splice(idx, 1);
      const kind = roll < 75 ? "complete" : roll < 90 ? "release" : "cancel";
      events.push({ kind, vtime, runId });
    }
  }
  return events;
}

describe("precedence over the random corpus", () => {
  it("the reported reason matches the declared order on every refused admit", () => {
    const divergences: string[] = [];
    let overlaps = 0;
    let refusals = 0;

    for (let seed = 1; seed <= 300; seed++) {
      const history = makeHistory(seed, 120);
      const d = new DrivenPlane(DEFAULT_CONTROL_PLANE);
      for (let i = 0; i < history.length; i++) {
        const ev = history[i] as RefEvent;
        if (ev.kind !== "admit") {
          if (ev.kind === "release") d.release(ev.vtime, ev.runId);
          else if (ev.kind === "complete") d.complete(ev.vtime, ev.runId);
          else d.cancel(ev.vtime, ev.runId);
          continue;
        }
        const conditions = referenceRefusals(DEFAULT_CONTROL_PLANE, history, i);
        const r = d.admit(ev.vtime, ev.tenant, ev.runId);
        if (conditions.length > 1) overlaps++;
        if (r.ok) continue;
        refusals++;
        const declared = resolveByPrecedence(conditions);
        if (r.reason !== declared) {
          divergences.push(`seed ${seed} @${i}: impl ${r.reason}, declared ${declared}`);
        }
      }
    }

    expect(refusals, "the corpus must actually refuse things").toBeGreaterThan(100);
    // The corpus's own non-vacuity for THIS property.
    expect(
      overlaps,
      "no admit in 300 histories had two conditions true at once, so the " +
        "corpus cannot observe precedence — the hand-built scenarios are the " +
        "only coverage and this assertion should say so",
    ).toBeGreaterThan(0);
    expect(divergences.slice(0, 5)).toEqual([]);
  });
});

describe("the streaming ledger and the from-scratch replay agree", () => {
  /**
   * `applyEvent` is written once, but it is USED two ways: `referenceDecision`
   * restarts from nothing every time (the from-scratch property the whole
   * oracle argument rests on), while the corpora keep one world and advance it
   * per event, because recomputing from scratch after every one of 120 events
   * across 2,000 seeds is cubic. The rules cannot diverge — there is one copy —
   * but the STATE can, if anything ever mutates a world out of band.
   */
  it("event for event, across 50 seeded histories", () => {
    const mismatches: string[] = [];
    for (let seed = 1; seed <= 50; seed++) {
      const history = makeHistory(seed, 60);
      const world = emptyWorld();
      for (let i = 0; i < history.length; i++) {
        const ev = history[i] as RefEvent;
        applyEvent(DEFAULT_CONTROL_PLANE, world, ev);
        const streamed = creditsInWindow(DEFAULT_CONTROL_PLANE, world, ev.vtime);
        const scratch = referenceCreditsSpent(
          DEFAULT_CONTROL_PLANE,
          history,
          i,
          ev.vtime,
        );
        for (const [tenant, n] of streamed) {
          if (scratch.get(tenant) !== n) {
            mismatches.push(
              `seed ${seed} @${i} ${tenant}: streamed ${n}, scratch ${scratch.get(tenant)}`,
            );
          }
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});

describe("the oracle's inputs cannot be wired to each other", () => {
  /**
   * L11 IN ONE ASSERTION.
   *
   * I4 compared a map to itself for every event of all 2,000 seeds, because the
   * corpus passed `creditsSpentMap()` as BOTH `creditsSpent` and
   * `creditsExpected`. Nothing about that reads as broken — the field names are
   * right there and they are different. What was wrong was the expressions.
   *
   * So the property asserted is structural and has nothing to do with what the
   * README says: no file may pass the SAME expression to both sides of a
   * differential invariant. It would have caught L11 on the day it was written,
   * and it catches the copy-paste that reintroduces it.
   */
  it("no CheckableState passes one expression to both sides of I4", () => {
    const offenders: string[] = [];
    const files = [
      ...readdirSync(join(root, "test"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join("test", f)),
      ...readdirSync(join(root, "test", "support"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join("test", "support", f)),
    ];
    for (const rel of files) {
      const src = readFileSync(join(root, rel), "utf8");
      const spent = [...src.matchAll(/creditsSpent:\s*([^\n]+?),\s*$/gm)].map((m) =>
        (m[1] as string).trim(),
      );
      const expected = [...src.matchAll(/creditsExpected:\s*([^\n]+?),\s*$/gm)].map((m) =>
        (m[1] as string).trim(),
      );
      for (const e of expected) {
        // A shared LITERAL is a deliberately-built fixture: two `new Map()`
        // expressions are two different maps, and a synthetic healthy state is
        // allowed to say the same thing twice. What must never be shared is an
        // expression that READS the live system — that is L11 exactly, and it
        // is what makes the two sides move together instead of independently.
        if (/^new Map\(/.test(e)) continue;
        if (spent.includes(e)) offenders.push(`${rel}: both sides are \`${e}\``);
      }
    }
    expect(offenders, "I4 wired to itself — the L11 shape").toEqual([]);
  });

  it("only the shared harness builds a CheckableState out of a ControlPlane", () => {
    // Five copies of `stateOf` existed and they drifted independently. A
    // synthetic CheckableState (invariants.test.ts, mutants.test.ts) is fine —
    // those are deliberately broken states. What must not spread again is the
    // wiring that reads a live plane.
    const offenders = readdirSync(join(root, "test"))
      .filter((f) => f.endsWith(".test.ts"))
      .filter((f) => {
        const src = readFileSync(join(root, "test", f), "utf8");
        return /creditsSpent:\s*\w*plane\.|creditsSpent:\s*this\.plane\./i.test(src);
      });
    expect(offenders, "CheckableState built from a plane outside the harness").toEqual(
      [],
    );
  });
});
