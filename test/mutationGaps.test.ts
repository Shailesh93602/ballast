import { describe, it, expect } from "vitest";
import { ControlPlane } from "../src/policy/controlPlane.js";
import { ReplayLog, type SubscriberState } from "../src/policy/replayLog.js";
import { DEFAULT_CONTROL_PLANE } from "../src/policy/types.js";

/**
 * Tests written to kill specific mechanical-mutation survivors.
 *
 * Every test here exists because `node scripts/mutate.mjs` found a mutation the
 * suite could not detect. That is the useful direction of the mutation score: a
 * survivor is a question ("what would break if this line were wrong?") and the
 * answer belongs in a test, not in a triage note saying "acceptable".
 *
 * Each names the survivor it kills, so a future reader can tell these apart from
 * tests written to describe behaviour.
 */

describe("killing mutation survivors — control plane", () => {
  it("kills `delete this.currentWindow = window` — the window must actually advance", () => {
    // Survivor: deleting the assignment meant `currentWindow` stayed 0 forever,
    // so every admit looked like a new window and credits reset every call —
    // the quota would never bind at all.
    const plane = new ControlPlane({
      ...DEFAULT_CONTROL_PLANE,
      poolCapacity: 20,
      tenants: [{ id: "solo", cap: 20, creditsPerWindow: 2 }],
    });

    expect(plane.admit(0, "solo", "a").ok).toBe(true);
    expect(plane.admit(1, "solo", "b").ok).toBe(true);
    // Third admit in the SAME window must be refused...
    const third = plane.admit(2, "solo", "c");
    expect(third.ok, "budget of 2 must bind within one window").toBe(false);

    // ...and a fourth, at a still-later tick inside the same window, too.
    // (If the window pointer never advanced, this would wrongly succeed.)
    const fourth = plane.admit(50, "solo", "d");
    expect(fourth.ok, "still the same window at t=50 with windowTicks=100").toBe(false);
  });

  it("kills `negate if (run.slotId !== null)` in complete — completion frees the slot", () => {
    // Survivor: negating meant completion released only when there was no slot,
    // i.e. never. SEMANTICS B6 says completion is terminal and frees capacity.
    const plane = new ControlPlane({
      ...DEFAULT_CONTROL_PLANE,
      poolCapacity: 1,
      tenants: [{ id: "t", cap: 1, creditsPerWindow: 50 }],
    });

    expect(plane.admit(0, "t", "r1").ok).toBe(true);
    expect(plane.totalClaimed).toBe(1);

    plane.complete(1, "r1", "completed");
    expect(plane.totalClaimed, "completing must return the slot (B6)").toBe(0);

    // And the freed capacity must be genuinely reusable.
    expect(plane.admit(2, "t", "r2").ok, "the pool slot should be available again").toBe(
      true,
    );
  });

  it("kills `negate if (run.slotId !== null)` in cancel — cancelling frees the slot", () => {
    const plane = new ControlPlane({
      ...DEFAULT_CONTROL_PLANE,
      poolCapacity: 1,
      tenants: [{ id: "t", cap: 1, creditsPerWindow: 50 }],
    });

    expect(plane.admit(0, "t", "r1").ok).toBe(true);
    expect(plane.totalClaimed).toBe(1);

    plane.cancel(1, "r1");
    expect(plane.totalClaimed, "cancelling must return the slot").toBe(0);
    expect(plane.admit(2, "t", "r2").ok).toBe(true);
  });

  it("kills `delete releasesThisGeneration.set(...)` — a second release is detected", () => {
    // Survivor: without the per-generation counter, a slot released twice looked
    // like two legitimate first-releases, so I5 could never see a double release.
    const plane = new ControlPlane(DEFAULT_CONTROL_PLANE);
    const a = plane.admit(0, "acme", "r1");
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    expect(plane.release(1, a.slotId, a.token).ok).toBe(true);
    // Second release of the same slot in the same generation must not be
    // recorded as a clean accepted release.
    plane.release(2, a.slotId, a.token);

    const accepted = plane.counters.acceptedReleases.filter((r) => r.slotId === a.slotId);
    const doubles = accepted.filter((r) => r.priorReleasesOfGeneration > 0);
    expect(
      accepted.length === 1 || doubles.length > 0,
      "a repeat release must either be refused or recorded as a repeat",
    ).toBe(true);
  });

  it("kills the duplicate-completion replayId mutant — duplicates echo the ORIGINAL id", () => {
    // Survivor context: a helper always returned undefined, so every duplicate
    // answered replayId 0. A caller correlating the ack to a log position would
    // have been silently misled.
    const plane = new ControlPlane(DEFAULT_CONTROL_PLANE);
    plane.admit(0, "acme", "r1");
    const first = plane.complete(1, "r1", "completed");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.replayId).toBeGreaterThan(0);

    const dup = plane.complete(2, "r1", "completed");
    expect(dup.ok).toBe(true);
    if (!dup.ok) return;
    expect(dup.duplicate).toBe(true);
    expect(dup.replayId, "a duplicate must echo the original replay id").toBe(
      first.replayId,
    );
  });
});

describe("killing mutation survivors — replay log", () => {
  it("kills `retentionCount <= -> <` — retention keeps EXACTLY the bound, not one fewer", () => {
    // Survivor: the off-by-one at the retention boundary is invisible unless a
    // test pins the exact retained count.
    const log = new ReplayLog(5, 10_000);
    for (let i = 0; i < 20; i++) {
      log.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" });
    }
    log.evict(20);
    expect(log.size, "retention of 5 must retain exactly 5, not 4").toBe(5);
  });

  it("kills `retentionTicks <= -> <` — an entry exactly AT the age bound is kept", () => {
    // Survivor: the age boundary is invisible unless a test sits an entry
    // exactly on it. Retention of N ticks must keep an entry whose age is
    // exactly N and drop one at N+1 — otherwise "retain for N ticks" quietly
    // means N-1, and a subscriber resuming at the documented horizon gets a
    // retention-exceeded error it was told it would not.
    const log = new ReplayLog(1000, 10);

    log.append({
      vtime: 0,
      tenant: "t",
      runId: "exactly-at-bound",
      outcome: "completed",
    });
    log.append({ vtime: 5, tenant: "t", runId: "well-within", outcome: "completed" });

    // now = 10 -> the first entry's age is exactly 10, which is <= 10: KEEP.
    log.evict(10);
    expect(log.size, "an entry exactly at the age bound must be retained").toBe(2);

    // now = 11 -> its age is 11, past the bound: DROP.
    log.evict(11);
    expect(log.size, "an entry one tick past the bound must be evicted").toBe(1);
  });

  it("kills `delete sub.credits = grantedCredits` — an ack must re-grant credit", () => {
    // Survivor: without the assignment, credits never changed on ack, so a
    // subscriber's window could never be widened or narrowed by the consumer —
    // credit-based flow control would be decorative.
    const log = new ReplayLog(1000, 10_000);
    for (let i = 0; i < 20; i++) {
      log.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" });
    }
    const sub: SubscriberState = { name: "s", cursor: 1, credits: 2, inFlight: 0 };

    expect(log.deliver(sub).length).toBe(2);
    // Ack with a LARGER grant — the consumer is asking for more.
    log.acknowledge(sub, 2, 6);
    expect(sub.credits, "the ack's grant must take effect").toBe(6);
    expect(log.deliver(sub).length, "a widened window must deliver more").toBe(6);

    // And a NARROWER grant must also take effect — backpressure in both directions.
    log.acknowledge(sub, 8, 1);
    expect(sub.credits).toBe(1);
    expect(log.deliver(sub).length).toBe(1);
  });

  it("kills `available <= 0 -> available < 0` — zero credit delivers nothing", () => {
    const log = new ReplayLog(1000, 10_000);
    for (let i = 0; i < 5; i++) {
      log.append({ vtime: i, tenant: "t", runId: `r${i}`, outcome: "completed" });
    }
    const sub: SubscriberState = { name: "s", cursor: 1, credits: 0, inFlight: 0 };
    expect(log.deliver(sub), "zero available credit must deliver nothing").toEqual([]);

    // And the in-flight ceiling counts too: credits 2, already 2 in flight.
    const busy: SubscriberState = { name: "b", cursor: 1, credits: 2, inFlight: 2 };
    expect(log.deliver(busy), "a full window must deliver nothing").toEqual([]);
  });
});

describe("killing mutation survivors — credit accounting", () => {
  it("kills the creditsExpected mutant — the independent recomputation is exercised", () => {
    // Survivor: creditsExpected() was never called by any test, so mutating it
    // changed nothing observable. I4 compares spent against expected, so leaving
    // the recomputation untested left half of that invariant unguarded.
    const plane = new ControlPlane(DEFAULT_CONTROL_PLANE);
    plane.admit(0, "acme", "r1");
    plane.admit(0, "acme", "r2");
    plane.cancel(1, "r3-never-admitted");

    const expected = plane.creditsExpected();
    const spent = plane.creditsSpentMap();

    // Two accepted admits for acme -> two credits, by both routes.
    expect(spent.get("acme")).toBe(2);
    expect(
      expected.get("acme"),
      "the independent recomputation must agree with the running counter",
    ).toBe(2);

    // A run that was never admitted must not appear as having spent credit.
    expect(expected.get("")).toBeUndefined();
  });
});
