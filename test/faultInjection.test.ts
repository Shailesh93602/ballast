import { describe, it, expect } from "vitest";
import { DEFAULT_CONTROL_PLANE } from "../src/policy/types.js";
import { Rng } from "../src/core/rng.js";
import { Substrate, DEFAULT_SUBSTRATE, HONEST_SUBSTRATE } from "../src/sim/substrate.js";
import { checkAll } from "../src/oracle/invariants.js";
import { DrivenPlane } from "./support/planeHarness.js";

/**
 * THE FAULT INJECTOR, CONNECTED TO THE CONTROL PLANE.
 *
 * `src/sim/substrate.ts` opens with "a control plane is only interesting
 * because the thing underneath it is unreliable", the README calls it "the
 * substrate that lies", and `controlPlane.ts` said the substrate "injects
 * duplicate and reordered requests to expose" the check-then-claim race.
 *
 * It did not. Before this file, `Substrate` appeared in exactly two places:
 * its own unit test (which asserts it produces faults at the right rate and
 * weights them toward boundaries — in isolation, wired to nothing), and
 * `khatago.test.ts`, where the only fault consulted is `pod-death`. The control
 * plane was driven exclusively by clean, well-formed histories: no duplicate
 * requests, no reordering, no retried timeouts.
 *
 * KG2 says that finding zero unplanted violations means the fault injector is
 * too weak. An injector connected to nothing is the limiting case of that.
 *
 * Everything here is still a pure function of the seed: the faults come from a
 * forked `Rng`, so the whole delivery schedule replays byte-identically.
 */

interface Op {
  readonly kind: "admit" | "release" | "complete" | "cancel";
  readonly vtime: number;
  readonly tenant: string;
  readonly runId: string;
}

/** The clean workload, before the substrate gets to mangle its delivery. */
function baseWorkload(rng: Rng, length: number): Op[] {
  const tenants = DEFAULT_CONTROL_PLANE.tenants.map((t) => t.id);
  const ops: Op[] = [];
  const live: Array<{ runId: string; tenant: string }> = [];
  let vtime = 0;
  for (let i = 0; i < length; i++) {
    vtime += rng.nextInt(0, 4);
    const roll = rng.nextInt(0, 100);
    if (roll < 55 || live.length === 0) {
      const tenant = tenants[rng.nextInt(0, tenants.length)] as string;
      const runId = `r${i}`;
      ops.push({ kind: "admit", vtime, tenant, runId });
      live.push({ runId, tenant });
    } else {
      const idx = rng.nextInt(0, live.length);
      const run = live[idx] as { runId: string; tenant: string };
      live.splice(idx, 1);
      const kind = roll < 78 ? "complete" : roll < 92 ? "release" : "cancel";
      ops.push({ kind, vtime, tenant: run.tenant, runId: run.runId });
    }
  }
  return ops;
}

/**
 * Apply the substrate's faults to the DELIVERY of each operation.
 *
 * Only the faults that mean something at this API are modelled, and each is
 * named so a failure says which one produced it:
 *
 *   duplicate  — at-least-once delivery: the same request arrives twice
 *   reorder    — two concurrent responses land out of order
 *   delay      — a request arrives `delayTicks` later than it was issued
 *   timeout    — the caller never learns the outcome, so it RETRIES
 *   pod-death  — the run never reports back; its terminal op is dropped
 *
 * `stale-ready` and `lost-append` are deliberately not modelled here: the
 * control plane performs no readiness poll and the log's durability is internal.
 * Saying so is the point — an injector whose faults quietly do nothing is worse
 * than a smaller one that does.
 */
function deliver(ops: readonly Op[], substrate: Substrate): Op[] {
  const out: Op[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Op;
    const fault = substrate.nextFault();
    switch (fault.kind) {
      case "duplicate":
        out.push(op, op);
        break;
      case "timeout":
        // The caller saw nothing and reissued the identical request.
        out.push(op, { ...op, vtime: op.vtime + 1 });
        break;
      case "reorder": {
        const next = ops[i + 1];
        if (next === undefined) {
          out.push(op);
        } else {
          // Swap, keeping virtual time non-decreasing for the recorder.
          out.push({ ...next, vtime: op.vtime }, { ...op, vtime: next.vtime });
          i++;
        }
        break;
      }
      case "delay":
        out.push({ ...op, vtime: op.vtime + fault.delayTicks });
        break;
      case "pod-death":
        // The worker died: an admit still happened, a terminal op never arrives.
        if (op.kind === "admit") out.push(op);
        break;
      default:
        out.push(op);
    }
  }
  // vtime must not go backwards — the plane refuses that, and it is the
  // recorder's job, not the injector's, to keep the stream monotonic.
  let last = 0;
  return out.map((op) => {
    const vtime = Math.max(last, op.vtime);
    last = vtime;
    return { ...op, vtime };
  });
}

interface RunResult {
  readonly violations: Array<{ seed: number; invariant: string; detail: string }>;
  readonly faultsInjected: number;
  readonly opsDelivered: number;
}

function runCorpus(seeds: number, faulted: boolean): RunResult {
  const violations: RunResult["violations"] = [];
  let faultsInjected = 0;
  let opsDelivered = 0;

  for (let seed = 1; seed <= seeds; seed++) {
    const rng = new Rng(seed);
    const substrate = new Substrate(
      rng.fork("faults"),
      faulted ? DEFAULT_SUBSTRATE : HONEST_SUBSTRATE,
    );
    const ops = deliver(baseWorkload(rng.fork("workload"), 120), substrate);
    faultsInjected += substrate.injectedCount;
    opsDelivered += ops.length;

    const d = new DrivenPlane(DEFAULT_CONTROL_PLANE);

    for (const op of ops) {
      if (op.kind === "admit") d.admit(op.vtime, op.tenant, op.runId);
      else if (op.kind === "release") d.release(op.vtime, op.runId);
      else if (op.kind === "complete") d.complete(op.vtime, op.runId);
      else d.cancel(op.vtime, op.runId);

      const found = checkAll(d.state(op.vtime));
      if (found.length > 0) {
        const first = found[0]!;
        violations.push({ seed, invariant: first.invariant, detail: first.detail });
        break;
      }
    }
  }
  return { violations, faultsInjected, opsDelivered };
}

describe("the control plane under the lying substrate", () => {
  it("the injector is actually connected — faults reach the delivery stream", () => {
    // The non-vacuity check, first, because everything below is worthless
    // without it. An injector wired to nothing passes every invariant.
    const faulted = runCorpus(50, true);
    const honest = runCorpus(50, false);

    expect(faulted.faultsInjected, "no faults were injected at all").toBeGreaterThan(
      1000,
    );
    expect(honest.faultsInjected, "the honest arm must inject nothing").toBe(0);
    expect(
      faulted.opsDelivered,
      "faults must change the delivered stream, not just be counted",
    ).toBeGreaterThan(honest.opsDelivered);
  });

  it("no invariant is violated across 500 fault-injected histories", () => {
    const { violations } = runCorpus(500, true);
    expect(violations.slice(0, 5), "invariant violations under fault injection").toEqual(
      [],
    );
  });

  it("the fault schedule is a pure function of the seed", () => {
    // Fault injection is worth nothing if a failure it finds cannot be replayed.
    const a = runCorpus(30, true);
    const b = runCorpus(30, true);
    expect(a.faultsInjected).toBe(b.faultsInjected);
    expect(a.opsDelivered).toBe(b.opsDelivered);
    expect(a.violations).toEqual(b.violations);
  });
});

describe("a retried request is a DUPLICATE request (SEMANTICS A9)", () => {
  /**
   * The case the injector exists to produce, pinned down on its own.
   *
   * `timeout` and `duplicate` both deliver the same `admit` twice, and at-least-
   * once delivery makes that routine rather than exotic. Admission is therefore
   * idempotent per `runId`: the second arrival re-describes the claim the first
   * one made, rather than taking a second slot and spending a second credit for
   * one logical run.
   */
  it("a duplicate admit does not consume a second slot or a second credit", () => {
    const d = new DrivenPlane(DEFAULT_CONTROL_PLANE);
    const first = d.admit(0, "acme", "r1");
    expect(first.ok).toBe(true);

    const retry = d.admit(1, "acme", "r1");
    expect(retry.ok, "the retry must still be answered ok — it succeeded").toBe(true);

    expect(d.plane.totalClaimed, "one run, one slot").toBe(1);
    expect(d.plane.creditsSpentMap(1).get("acme"), "one run, one credit").toBe(1);
    expect(checkAll(d.state(1))).toEqual([]);
  });

  it("the retry echoes the ORIGINAL slot and token, so the caller can still release", () => {
    // Answering with a fresh token would leave the caller holding a token the
    // plane has forgotten — the same shape as L6, where duplicates answered
    // replayId 0 and a correlating caller was silently misled.
    const d = new DrivenPlane(DEFAULT_CONTROL_PLANE);
    const first = d.admit(0, "acme", "r1");
    const retry = d.admit(1, "acme", "r1");
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;

    expect(retry.slotId).toBe(first.slotId);
    expect(retry.token).toBe(first.token);
    expect(d.plane.release(2, retry.slotId, retry.token).ok).toBe(true);
    expect(d.plane.totalClaimed).toBe(0);
  });

  it("an admit arriving AFTER the run completed is REFUSED — ids are single-use", () => {
    // The boundary, and it is a refusal rather than a fresh claim for a reason
    // I8 makes concrete: a new RunState resets `effectApplied`, so completing
    // the re-admitted run would apply the effect for `r1` a SECOND time. That
    // violation is reachable through this door and no other.
    const d = new DrivenPlane(DEFAULT_CONTROL_PLANE);
    expect(d.admit(0, "acme", "r1").ok).toBe(true);
    d.complete(1, "r1");
    expect(d.plane.effectCountsMap().get("r1")).toBe(1);

    const late = d.admit(2, "acme", "r1");
    expect(late.ok, "a late duplicate must not resurrect a finished run").toBe(false);
    if (!late.ok) expect(late.reason).toBe("run-already-terminal");

    d.complete(3, "r1");
    expect(d.plane.effectCountsMap().get("r1"), "still exactly one effect").toBe(1);
    expect(d.plane.creditsSpentMap(3).get("acme"), "and exactly one credit").toBe(1);
    expect(checkAll(d.state(3))).toEqual([]);
  });
});

describe("a claim that is GONE is not a duplicate of anything (SEMANTICS A10, C7)", () => {
  /**
   * THE FOURTH DOOR.
   *
   * C6 asked "is this still my slot?" of every path that FREES a slot, after
   * L10 found `complete()` and `cancel()` freeing by id alone. It enumerated
   * three doors because those were the three that free. The path that GRANTS a
   * slot back — A9's duplicate-admit echo — was never asked, and it was
   * checking only that the named slot EXISTS. Slots are never removed from the
   * array, so that check was always true.
   */
  it("a re-admit after RELEASE takes a fresh slot instead of echoing a dead grant", () => {
    const d = new DrivenPlane(DEFAULT_CONTROL_PLANE);
    const first = d.admit(0, "acme", "r1");
    expect(first.ok).toBe(true);
    expect(d.release(1, "r1")?.ok).toBe(true);
    expect(d.plane.totalClaimed, "the slot went back to the pool").toBe(0);

    const again = d.admit(2, "acme", "r1");
    expect(again.ok).toBe(true);
    if (!again.ok || !first.ok) return;

    // Pre-fix this answered `ok: true` with slot-0 and token 1 while
    // totalClaimed stayed 0 — a grant for a slot the plane did not hold.
    expect(d.plane.totalClaimed, "a fresh claim actually takes a slot").toBe(1);
    expect(again.token, "a fresh claim gets a fresh fencing token").toBeGreaterThan(
      first.token,
    );
    expect(
      d.plane.creditsSpentMap(2).get("acme"),
      "a second claim is a second debit (A3, A10)",
    ).toBe(2);
    expect(checkAll(d.state(2))).toEqual([]);
  });

  it("a re-admit after the slot was RECLAIMED never names the new owner's slot", () => {
    // The worst shape of it: acme's lease expires, globex takes the slot, and
    // acme's at-least-once retry arrives. Pre-fix acme was answered
    // `slotId: slot-0, token: 1, leaseUntil: <globex's>` — globex's slot,
    // globex's lease, acme's dead token — while acme's in-flight stayed 0.
    const d = new DrivenPlane({
      ...DEFAULT_CONTROL_PLANE,
      poolCapacity: 1,
      leaseTicks: 10,
      tenants: [
        { id: "acme", cap: 1, creditsPerWindow: 50 },
        { id: "globex", cap: 1, creditsPerWindow: 50 },
      ],
    });
    const acme = d.admit(0, "acme", "r1");
    expect(acme.ok).toBe(true);
    const globex = d.admit(20, "globex", "g1");
    expect(globex.ok, "globex claims the expired slot").toBe(true);
    if (!acme.ok || !globex.ok) return;
    expect(acme.slotId).toBe(globex.slotId);

    const retry = d.admit(21, "acme", "r1");
    expect(retry.ok, "the pool is full, so the retry must be REFUSED").toBe(false);
    if (retry.ok) {
      expect(retry.token, "never hand back a token the slot no longer holds").not.toBe(
        acme.token,
      );
    }
    expect(
      d.plane.inFlightByTenant().get("globex"),
      "globex must still hold its slot",
    ).toBe(1);
    expect(checkAll(d.state(21))).toEqual([]);
  });

  it("a duplicate of a LIVE claim still echoes — A9 is unchanged", () => {
    // The boundary in the other direction: tightening the check must not turn
    // the at-least-once retry A9 exists for into a second claim.
    const d = new DrivenPlane(DEFAULT_CONTROL_PLANE);
    const first = d.admit(0, "acme", "r1");
    const retry = d.admit(1, "acme", "r1");
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.slotId).toBe(first.slotId);
    expect(retry.token).toBe(first.token);
    expect(d.plane.totalClaimed).toBe(1);
    expect(d.plane.creditsSpentMap(1).get("acme")).toBe(1);
  });
});
