# SEMANTICS.md — the decisions that define "correct"

**Status: DRAFT — awaiting ratification. Freeze target: Day 5.**
**Version: 0.1 (unfrozen)**

---

## Why this document exists, and why it is committed before any policy code

BALLAST checks an implementation against a reference model. That catches
implementation bugs — a mis-ordered write, a missed edge case, an off-by-one.

It does **not** catch a misunderstanding.

If a question like _"is the quota window sliding or tumbling?"_ is never asked
out loud, whoever writes the code picks one, and whoever writes the reference
model picks — the same one, because it is the same author on the same afternoon.
Both halves then agree perfectly, every differential test passes, and the system
is confidently wrong in a way **the oracle is structurally blind to.**

That is the one failure mode a differential test cannot see, and the reason this
file is Milestone 1 rather than documentation written afterwards. It is committed
**before `src/policy/` exists**, and the git history is the evidence that the
model was not reverse-engineered from the implementation. Expect to be asked.

**How to use this:** every row has a recommendation. Accept it, or override it.
Either is a decision. What is not acceptable is leaving a row `TBD` — a test
fails while any row still reads `TBD`.

**Amendments after freeze:** append a dated row at the bottom. Never edit a
frozen row in place, because the value of the git ordering is that it cannot be
rewritten.

---

## Legend

- **Q** — the question
- **→** — recommended answer
- **Else** — what happens if the other choice is taken
- **Guards** — the invariant that depends on this being pinned down
- **Status** — `DECIDED` / `TBD`

---

## A. Quota and credit

### A1 · Is the quota window sliding or tumbling?

**→ Tumbling**, aligned to fixed epochs of `windowTicks`.
**Else** a sliding window needs per-tenant timestamp history, which makes the
reference model O(n) per decision and the state unbounded in the number of
requests rather than the number of tenants. Tumbling is what real governor limits
do, and it is defensible in an interview ("burst at a boundary is a known
trade-off; here is what it costs").
**Known cost, stated deliberately:** a tenant can spend a full window's credits
at the end of one epoch and again at the start of the next — a 2× burst across
the boundary. This is accepted, not overlooked.
**Guards** I4. **Status: `DECIDED`**

### A2 · Window granularity?

**→ 100 ticks per window**, configurable per scenario.
**Else** too small and every run spans many windows so the quota never binds;
too large and the corpus never observes a window boundary, leaving A1's burst
behaviour untested.
**Guards** I4. **Status: `DECIDED`**

### A3 · When is credit debited — at admit, at claim, or at completion?

**→ At claim**, atomically with the slot acquisition.
**Else, at admit:** admission and resource acquisition can diverge — a run
admitted but never claimed (pool full) has spent credit for nothing, so a tenant
is billed for work that never ran.
**Else, at completion:** credit cannot bound concurrency at all, because a tenant
can start unlimited runs before the first completes. That defeats the entire
purpose.
**This is the single most consequential row in the file** — it is the one that
makes the credit ledger and the concurrency cap the same mechanism rather than
two mechanisms that disagree.
**Guards** I1, I4. **Status: `DECIDED`**

### A4 · Is credit refunded when a run is cancelled?

**→ Yes, if the run had not started executing; no, if it had.**
**Else, always refund:** a tenant can burn capacity indefinitely by starting and
cancelling — an unbounded free-work attack.
**Else, never refund:** a cancel racing an admit charges for work that never
happened, and A3 already accepted that admission and execution can diverge.
**Guards** I4. **Status: `DECIDED`**

### A5 · Is credit refunded when the pod dies mid-run?

**→ No.**
**Else** infrastructure failure becomes free retries, and the credit ledger stops
measuring consumed capacity — which is what it is for. The capacity _was_
consumed; it simply produced no result.
**Note:** this is a policy stance, not a correctness one. It is worth being able
to argue both sides in an interview; the ledger must merely be _consistent_.
**Guards** I4. **Status: `DECIDED`**

### A6 · Is credit refunded when a lease expires?

**→ No** — same reasoning as A5.
**Else** refunding makes the _most_ expensive failure mode — capacity held and
never released, blocking others for the whole TTL — also the cheapest for the
tenant that caused it. That is exactly backwards as an incentive.
**Guards** I4, I6. **Status: `DECIDED`**

### A7 · Does a duplicate completion debit credit twice?

**→ No.** Credit moves exactly once per `(runId, attempt)`, enforced by the same
CAS that makes the effect exactly-once.
**Else** at-least-once delivery silently drains a tenant's quota, and the ledger
diverges from reality in proportion to network flakiness.
**Guards** I4, I8. **Status: `DECIDED`**

---

## B. Caps and admission

### B1 · Does the cap apply to admitted runs or to claimed slots?

**→ Claimed slots.**
**Else** the cap bounds a queue rather than actual concurrency, so a tenant with
100 admitted-but-unclaimed runs still shows as under cap while consuming nothing
— and the number stops meaning "how much of the pool this tenant is using."
**Guards** I1. **Status: `DECIDED`**

### B2 · Is the cap checked before the claim, or inside it?

**→ Inside**, as part of the same atomic operation.
**Else** — and this is the classic bug this project exists to demonstrate — two
concurrent admits both read `inFlight = cap - 1`, both conclude there is room,
and both claim. The check and the mutation must be one indivisible step. The
implementation makes the cap predicate part of the compare-and-set, exactly as
KhataGO makes `WHERE aiStatus = PENDING` part of its claim.
**Guards** I1, I2. **Status: `DECIDED`**

### B3 · What if the pool has capacity but the tenant is at cap?

**→ Reject with `cap-exceeded`**, and do not queue.
**Else** queueing introduces a second scheduling dimension (queue ordering,
starvation, queue bounds) that triples the ambiguity surface for no gain in what
is being demonstrated. Explicitly a non-goal — see the scope exclusions.
**Guards** I1. **Status: `DECIDED`**

### B4 · What if the tenant is under cap but the pool is empty?

**→ Reject with `pool-full`.**
**Else** queueing here has the same cost as B3, plus a worse failure mode: a
queue drained in arrival order lets one tenant's backlog delay every other
tenant's next request, which is precisely the noisy-neighbour behaviour the caps
exist to prevent.
**Guards** I2. **Status: `DECIDED`**

### B5 · Are the two rejection reasons distinguishable to the caller?

**→ Yes**, and they are distinct values in the decision log.
**Else** an operator cannot tell "you are over your limit" from "the system is
full", which are opposite actions — buy more quota versus wait. Also makes the
fairness analysis in M7 impossible to interpret.
**Guards** — (observability, not correctness). **Status: `DECIDED`**

---

## C. Leases, fencing, and readiness

### C1 · Is the fencing token per-slot or global?

**→ Global monotonic**, one counter for the whole control plane.
**Else, per-slot:** tokens from different slots are incomparable, so a stale
claimant holding slot A's token 5 cannot be ordered against slot B's token 3 —
and cross-slot reasoning is exactly what you need when a worker was reassigned.
Global is also what Kleppmann's fencing-token argument assumes.
**Guards** I5. **Status: `DECIDED`**

### C2 · What happens when lease TTL is shorter than the readiness-poll interval?

**→ The lease expires and the slot is reclaimed**, and this is treated as a
legitimate configuration, not an error to reject.
**Else** forbidding it hides the most interesting bug class: a reclaimed slot
that the original holder still believes it owns. That is precisely what the
fencing token is for, and the corpus must contain the case.
**Guards** I5, I6. **Status: `DECIDED`**

### C3 · May any invariant depend on a readiness poll being truthful?

**→ No. This is a hard design constraint, not a preference.**
The substrate can report a dead pod as ready. Every invariant must hold even when
every readiness read is a lie.
**Else** the whole simulation becomes a test of a substrate that behaves, which
is not a test at all.
**Guards** all of them. **Status: `DECIDED`**

### C4 · Can a lease be renewed, and does renewal re-validate the token?

**→ Renewal exists, and it re-validates.** A renewal from a stale token is
rejected.
**Else** renewal becomes a way to launder a stale claim back into a live one,
which silently undoes C1.
**Guards** I5. **Status: `DECIDED`**

### C5 · What reclaims an expired lease — a sweeper, or the next claimant?

**→ Lazily, by the next claimant** that encounters the expired slot.
**Else** a sweeper is a second concurrent actor, and its scheduling becomes
another ordering dimension the seed must control. Lazy reclamation keeps the
system single-decision-maker, which is what makes the reference model tractable.
**Known cost:** a slot can sit expired-but-unreclaimed while nobody is asking for
capacity. This is invisible externally and is accepted.
**Guards** I3, I6. **Status: `DECIDED`**

---

## D. Cancellation

### D1 · Cancel racing an admit — who wins?

**→ The cancel.** The admit is rejected with `cancelled-before-start`.
**Else** admitting a run the caller has already cancelled means doing work
nobody wants, and the caller has no way to stop it.
**Guards** I3. **Status: `DECIDED`**

### D2 · Cancel racing a completion — who wins?

**→ The completion**, if it has already been durably recorded. The cancel becomes
a no-op reported as `already-complete`.
**Else** cancelling a finished run would have to un-record a durable effect,
which is not possible and would make the completion log non-monotonic.
**Guards** I7, I8. **Status: `DECIDED`**

### D3 · Cancelling a run whose pod already died?

**→ Succeeds**, and is idempotent with the lease-expiry path — whichever happens
first releases the slot; the second is a no-op.
**Else** the caller gets an error for a perfectly reasonable request, and the
slot's release depends on which of two failures happened first.
**Guards** I3, I5. **Status: `DECIDED`**

### D4 · Cancel arriving twice?

**→ Idempotent.** The second returns the same outcome as the first.
**Else** at-least-once delivery makes duplicate cancels routine, and a
double-release is I5's headline violation.
**Guards** I5. **Status: `DECIDED`**

### D5 · Does a cancel return the slot to the pool or to the tenant's cap first?

**→ Both, in one atomic step.** They are two views of one release, not two
sequential operations.
**Else** any window where the slot is released from one and not the other is a
window where I1 and I2 disagree — and a fault injected exactly there produces a
violation that is real but whose root cause is this ambiguity, not a bug.
**Guards** I1, I2, I3. **Status: `DECIDED`**

---

## E. The replay log

### E1 · Is retention bounded by count, by virtual age, or both?

**→ Both.** Evict when either bound is exceeded.
**Else, count only:** a quiet period keeps ancient events alive forever.
**Else, age only:** a burst blows memory before anything ages out.
Real systems bound both, and the interesting subscriber behaviour only appears
when eviction actually happens.
**Guards** I7. **Status: `DECIDED`**

### E2 · What does a subscriber receive if it resubscribes from a replay ID that has been evicted?

**→ An explicit `retention-exceeded` error, not a silent jump to the oldest
retained event.**
**Else** silently fast-forwarding means the subscriber believes it has seen a
contiguous stream when it has a hole — and it has no way to discover the hole.
This mirrors the Pub/Sub API contract, where a too-old replay ID is an error the
client must handle.
**Guards** I7. **Status: `DECIDED`**

### E3 · Are replay IDs opaque or structured?

**→ Opaque to the subscriber, monotonic internally.** Subscribers may only
compare them for equality and pass them back.
**Else** exposing an integer invites clients to do arithmetic on it, which
freezes the internal representation into the public contract forever.
**Guards** I7. **Status: `DECIDED`**

### E4 · Are subscriber credits denominated per-event or per-byte?

**→ Per-event.**
**Else** per-byte requires a size model for every event, which adds a whole
dimension of simulated detail without changing the flow-control problem being
demonstrated.
**Guards** I7. **Status: `DECIDED`**

### E5 · What happens at zero credits — pause, or drop?

**→ Pause.** The log holds position for that subscriber; nothing is dropped.
**Else** dropping makes the subscriber's view non-contiguous, which contradicts
E2's whole argument, and turns a flow-control problem into a data-loss problem.
**This is the row that makes the project's central conflation argument coherent:**
a completion stream is a _fold_, so dropping is corruption, not degradation.
**Guards** I7. **Status: `DECIDED`**

### E6 · Are credits decremented on send, or on acknowledgement?

**→ On acknowledgement.**
**Else** decrementing on send means credits measure what the publisher _emitted_,
not what the subscriber _absorbed_ — so a slow or dead subscriber never applies
backpressure, which is the entire point of credit-based flow control.
**This is a planted mutant in M5.**
**Guards** I7. **Status: `DECIDED`**

### E7 · Duplicate completion arriving after the log has already advanced past that run?

**→ Acked, not errored.** The effect is already recorded; the duplicate is
acknowledged so the sender stops retrying.
**Else** returning an error makes the sender retry forever, and at-least-once
delivery guarantees this case happens.
**Guards** I7, I8. **Status: `DECIDED`**

### E8 · Out-of-order completion for a run that was already cancelled?

**→ Recorded as `completed-after-cancel`, and the effect is NOT applied.**
**Else, applying it:** the cancel becomes meaningless.
**Else, dropping it silently:** the operator cannot explain where the work went.
**Guards** I7, I8. **Status: `DECIDED`**

---

## F. Conservation and observability

### F1 · Is `claimed − released == inFlight` checked continuously or at quiescence?

**→ After every single event.**
**Else** an end-of-run check misses transient violations entirely — and a
transient violation is exactly what a fault injected mid-operation produces.
**Guards** I3. **Status: `DECIDED`**

### F2 · Does the decision log record rejections as well as admissions?

**→ Yes, both.**
**Else** the log cannot distinguish "no request arrived" from "a request was
refused", which makes the fairness measurement in M7 uninterpretable.
**Guards** — (observability). **Status: `DECIDED`**

### F3 · Is the liveness bound N a constant or calibrated?

**→ Calibrated from the corpus**, then asserted from _both_ sides: the observed
max must be ≤ N, **and** ≥ 0.5·N.
**Else** a hand-picked generous N makes I6 vacuous — it passes because it can
never fail, which is worse than not having it.
**Guards** I6. **Status: `DECIDED`**

### F4 · Does the simulation ever report wall-clock time?

**→ Never. Virtual ticks only.**
**Else** any wall-clock number is unreproducible, machine-dependent, and would
be the first thing an interviewer asks to see reproduced.
**Guards** — (the determinism claim itself). **Status: `DECIDED`**

---

## G. Open — these genuinely need Shailesh

### G1 · Should a tenant's cap be static, or derived from its credit balance?

**→ Recommend static**, configured per tenant.
**Else** a cap derived from remaining credit couples two mechanisms that are
clearer apart, and makes the reference model's cap a function of the entire
history rather than of config — which makes every differential divergence harder
to attribute. The argument _for_ deriving it: it is closer to how real governor
limits behave, where exhausting quota does throttle concurrency.
**Guards** I1, I4. **Status: `TBD` — his call.**

### G2 · Should the warm pool model warm-up latency, or are slots instantly usable?

**→ Recommend modelling warm-up** — a fixed `warmupTicks` before a fresh slot is
usable, with pre-warmed slots skipping it.
**Else** omitting warm-up removes the entire reason a warm pool exists, and this
is the row where his day job has the most to say: a pre-warmed browser pool is
built _precisely_ because cold start is expensive. The cost of including it is
one more state in the slot lifecycle, and therefore one more place a fault can
land.
**Guards** I2, I3. **Status: `TBD` — his call.**

### G3 · Should the corpus include a tenant with cap = 0?

**→ Recommend yes** — a suspended tenant is a real operational state.
**Else** excluding it leaves every `cap > 0` assumption in the code untested, and
those assumptions are invisible until a tenant is actually suspended in
production. The cost is essentially zero: one more entry in the tenant config.
**Guards** I1. **Status: `TBD` — his call.**

---

## Ratification

| Session | Date | Rows covered        | Ratified by |
| ------- | ---- | ------------------- | ----------- |
| 1       |      | A1–A7, B1–B5        |             |
| 2       |      | C1–C5, D1–D5        |             |
| 3       |      | E1–E8, F1–F4, G1–G3 |             |

**Freeze:** on ratification of session 3, this becomes v1.0 and the header
changes to `FROZEN`. After that, amendments are appended below, never edited in.

## Amendments

_(none yet)_
