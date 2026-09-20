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

### A8 · What exactly is I4's "expected" side recomputing?

**→ Credits claimed in the CURRENT window**, which is what the counter it checks
measures.
**Else** a recomputation that counts every run ever admitted measures a
different quantity, and the two agree only until the first window boundary. It
went unnoticed because the corpus supplied the same object for both sides of I4
and no generated history ever reached tick 100 — two independent masks, either
sufficient on its own. See LEDGER L11, L12, L13.
**Known cost:** the recomputation is O(runs) per check rather than O(1), which
is the point — an oracle that shares the implementation's incremental state
shares its bugs.
**Guards** I4. **Status: `DECIDED`** — _added after the audit; see Amendments._

### A9 · Is admission idempotent per `runId`?

**→ Yes.** A second admit for a run that is still live echoes the grant the
caller already holds — same slot, same token — and takes no slot and spends no
credit. An admit for a run that has already COMPLETED is refused with
`run-already-terminal`: an identity is single-use.
**Else, treating each arrival as a fresh claim:** delivery is at-least-once, so
a retried admit is routine. Each retry then takes a second slot and spends a
second credit for one logical run, while `RunState` remembers only the last —
orphaning the earlier slot until its lease ages out. A7 settled exactly this
question for completions; it was never asked of admissions, and the gap was
invisible because no corpus generated a duplicate `runId` until the fault
injector was connected to the control plane (LEDGER L20, L21).
**Else, erroring on the duplicate:** an at-least-once sender retries forever.
E7 makes the same argument for completions.
**Else, allowing a completed id to be re-admitted:** a fresh `RunState` resets
`effectApplied`, so the effect for that identity can be applied a second time.
That is an I8 violation reachable through this door and no other.
**Known cost, stated deliberately:** `runs` is never pruned, so a single-use
identity means the map grows with the number of runs ever seen. That is already
true of the existing implementation; A9 makes it load-bearing rather than
incidental.
**Guards** I1, I4, I8. **Status: `DECIDED`** — _added after the audit; see
Amendments._

### A10 · Is a runId whose claim was RELEASED, or whose lease expired, re-admissible?

**→ Yes, as a FRESH claim** — a new slot, a new fencing token and a new credit.
A9's echo applies only while the claim is **live**.

**Else, echoing the old grant:** this is what the implementation did, and the
bug is worth stating exactly. A9's "still live" was implemented as
`run.slotId !== null`, and nothing clears `run.slotId` — not `release()`, not
lease expiry. Slots are never removed from the array either, so the existence
check it performed was always true. The plane therefore answered `ok: true` with
a slot it did not hold:

- after `release()`, it named a free slot while `totalClaimed` said 0;
- after the lease expired and another tenant reclaimed the slot, it named **that
  tenant's slot**, with that tenant's lease expiry and the original caller's
  dead token.

Both charge no credit, so the plane and its own ledger were wrong **together**,
which is why I4 stayed silent (see A8 and LEDGER L22).

**Else, treating a released identity as terminal** (the A9 answer for a
completed one): that would be a defensible alternative, and the reason it is
**not** the answer is worth being able to say out loud. A9 makes a completed id
single-use to protect `effectApplied` — re-admitting it would let I8's effect
fire twice. A released run applied no effect, so that argument does not reach
it. **The identity's single-use property is about effects, not about slots.**

**Consequence, accepted deliberately:** a retry of a released run spends a
second credit. That is A3 (debited at claim) plus A5/A6 (failure is not
refunded) applied consistently — a second claim is a second debit.

**Guards** I1, I3, I4. **Status: `DECIDED`** — _added after the audit; see
Amendments._

### A11 · Is the credit ledger a function of virtual time, or of traffic?

**→ Of virtual time.** The windows are fixed epochs (A1), so reading the ledger
at `now` reports the epoch containing `now`, whether or not anything has arrived
to roll it.

**Else** — what the implementation did — the counter is rolled lazily from
inside `admit`, so between a boundary and the next admission it still describes
an epoch that has **ended**. No admission decision could observe it, because
`admit` rolls before it reads, so it survived every test. It stops being
invisible the moment something else reads the ledger: an oracle deriving the
window from an event's own `vtime` disagrees, and the disagreement is real —
the answer to "how much has this tenant spent this window" depended on when that
tenant last asked. See LEDGER L25.

**Implementation note:** there is no roll step any more. The counter is stored
with the window it belongs to and every read is a projection at `now`, so
nothing can be stale.

**Guards** I4. **Status: `DECIDED`** — _added after the audit; see Amendments._

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

### B6 · Does recording a completion release the run's slot?

**→ Yes. Completion is terminal and frees capacity atomically with recording the
effect.**
**Else** a completed run keeps holding a slot until its lease expires, so the
pool stays occupied by work that has already finished — capacity that is
provably idle but unavailable. It also makes the observable meaning of
"in-flight" drift from "actually running", which is what B1 was trying to pin
down.
**Guards** I1, I2, I3.
**Status: `DECIDED`** — _added 2026-08-16 as an amendment. See the note below;
this row exists because the differential oracle caught the gap._

### B7 · When TWO refusal conditions hold at once, which one is reported?

**→ In this order, highest precedence first:**

1. `unknown-tenant`
2. `cancelled-before-start`
3. `run-already-terminal`
4. `cap-exceeded`
5. `no-credit`
6. `pool-full`

**The ordering rule, so the list is derivable rather than memorised:**
**permanent refusals before transient ones, and within the transient ones, the
condition closest to the caller first.**

- `unknown-tenant` is a **malformed request**, not a capacity decision. There is
  no cap to compare against and no budget to spend, so the capacity conditions
  are not merely false, they are not evaluable.
- `cancelled-before-start` and `run-already-terminal` are facts about the
  **identity's lifecycle** and are stable: retrying will never change them.
  Reporting a transient reason instead ("the pool is full") invites an
  at-least-once sender to retry a request that can never succeed.
- Among the three transient ones, `cap-exceeded` → `no-credit` → `pool-full`
  runs from "your own limit" through "your own quota" to "the system is full",
  which is the order of what the caller can do about it.

**Else** — and this is what was actually happening — the order is decided
implicitly by whichever check each engine happens to write first. Both engines
evaluated cap → credit → pool because one author wrote both, and neither
document nor test said so. **The differential compares the rejection reason,
which made the question look answered.** It was not: both halves derived the
order from the same unwritten decision, which is the shared-spec blind spot in
its purest form.

**The two engines therefore derive it differently now.** The implementation
short-circuits in its own source order. The reference evaluates every condition
and resolves the set through `REJECTION_PRECEDENCE`, which
`test/precedence.test.ts` asserts against **this list, parsed out of this
file**. They still share a specification; they can no longer share it silently.

**They already disagreed.** An admit naming an unknown tenant, for a runId that
had already been cancelled, was answered `unknown-tenant` by the implementation
and `cancelled-before-start` by the reference. Every corpus draws its tenants
from the configured list, so no history has ever contained that request. See
LEDGER L23.

**Known limit, stated rather than left to be found:** the pair
(`cancelled-before-start`, `run-already-terminal`) cannot both hold — `status`
is one field — so their relative order is declared here and is **structurally
unobservable**. The precedence test asserts which overlaps it actually reaches
and names that pair as unreachable, rather than quietly counting it as covered.

**Guards** I1, I4. **Status: `DECIDED`** — _added after the audit; see
Amendments._

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

**→ Renewal would re-validate.** A renewal from a stale token is rejected.
**Else** renewal becomes a way to launder a stale claim back into a live one,
which silently undoes C1.
🔴 **NOT IMPLEMENTED, and this row said otherwise for five weeks.** The surface
is three operations — `admit`, `release`, `complete` — and there is no `renew`.
The row read "Renewal exists" beside a `DECIDED` status, so a reader checking
the spec against the code found a guarantee with nothing behind it. The decision
stands as the answer _if_ renewal is added; what is corrected here is the claim
that it had been.
**Guards** I5. **Status: `DECIDED` (unimplemented — see the note above)**

### C5 · What reclaims an expired lease — a sweeper, or the next claimant?

**→ Lazily, by the next claimant** that encounters the expired slot.
**Else** a sweeper is a second concurrent actor, and its scheduling becomes
another ordering dimension the seed must control. Lazy reclamation keeps the
system single-decision-maker, which is what makes the reference model tractable.
**Known cost:** a slot can sit expired-but-unreclaimed while nobody is asking for
capacity. ~~This is invisible externally~~ — **that claim was wrong, and C8
replaces it.** The window is externally visible: a `release` arriving inside it
succeeds, because the slot still carries the holder's token. The cost is
accepted; the description of it was not accurate.
**Guards** I3, I6. **Status: `DECIDED`** — _`Known cost` corrected after the
audit; see C8 and the Amendments._

### C6 · A run whose lease expired is later completed or cancelled. Does that free the slot it used to hold?

**→ No, unless it is still the same claim.** Every path that frees a slot
compares the run's fencing token against the slot's current one; a mismatch is
refused exactly as `release()` refuses it.
**Else** `complete()` and `cancel()` free the slot named by `run.slotId`, which
after a reclaim belongs to someone else — so a stale claimant evicts a live
tenant's capacity. The damage is invisible to I1 and I2, which only fire when
the pool goes OVER its bounds, and to I3, which stays balanced because the
release is counted.
**This row exists because it was resolved silently and wrongly.** C1 and C4 are
about `release()`, and nobody asked the same question of the other two doors.
See LEDGER L10.
**Guards** I1, I2, I5. **Status: `DECIDED`** — _added after the audit that found
L10; see the Amendments section._

### C7 · Does the path that GRANTS a slot validate the fencing token too?

**→ Yes. Every path that reasons about "my slot" compares tokens — the ones that
free a slot (C6) and the one that hands a grant back.**

**Else** the duplicate-admit echo (A9) answers with whatever `run.slotId` names,
and after a reclaim that is somebody else's slot. The caller is told it holds
capacity it does not hold, pointing at a live tenant's slot.

**This row exists because C6 was written and then under-applied.** C6 came out
of L10 and says "every path that frees a slot compares the run's fencing token
against the slot's current one". It enumerated three doors — `release`,
`complete`, `cancel` — because those were the three that free. Nobody asked the
same question of the fourth door, the one that **grants**, and the audit that
wrote C6 did not catch it because it was looking for slot-freeing paths. The
general form, which is the useful one: **any code that resolves a stored
`slotId` back to a slot is making an ownership claim, whatever it then does with
it.** See LEDGER L22.

**Guards** I1, I3, I5. **Status: `DECIDED`** — _added after the audit; see
Amendments._

### C8 · A lease has expired but nothing has reclaimed the slot. Can the holder still release it?

**→ Yes.** Until something sweeps, the slot is still held by that claim, and its
holder may release it. Expiry becomes effective on RECLAMATION, not at the
instant the lease runs out.

**Else, checking the lease inside `release()`** — making expiry instantaneous —
gives two different answers to "when did this lease end" depending on which
operation asks. Admission would see a slot reclaimed at the moment an admit
sweeps (C5), and release would see it gone earlier. A lease with two expiry
times is worse than either rule on its own.

**The consequence for the reference model is the interesting part.** The
implementation reclaims only at the top of `admit`, so "has this run's slot been
swept" depends on whether any admit has arrived since the lease ran out — a
question about the event history, not about the run. A model that treats expiry
as a function of the clock alone disagrees with the implementation on exactly
the events that fall in the window, and this one did: **397 releases the
reference believed succeeded and the implementation refused, and 40 the other
way once expiry was made instantaneous.** Both directions were invisible for as
long as the differential compared only ADMIT decisions.

**Found by extending mutation to `src/oracle`** — nine mutants inside
`referenceDecision`'s release, complete and cancel branches survived, because no
assertion ever looked at their output. See LEDGER L28.

**Guards** I3, I5. **Status: `DECIDED`** — _added after the audit; see
Amendments._

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

### E9 · May a subscriber grant itself unlimited credit?

**→ No. The grant is the subscriber's REQUEST; the window is the publisher's
DECISION.** An acknowledgement carrying `grantedCredits` is clamped to
`[0, maxCredits]`, where `maxCredits` is configured on the log.

**Else** — what `acknowledge` did — `sub.credits = grantedCredits` takes the
number straight from the subscriber, unbounded. A subscriber asking for 10⁹
credits is then sent the entire log in one delivery, and credit-based flow
control becomes decorative: it constrains only the subscribers that choose to be
constrained. E6 is careful that credits measure what the subscriber **absorbed**
rather than what the publisher emitted, and this is the other half of that
argument — the publisher still decides how much it is willing to have
outstanding. A negative grant is clamped to 0 rather than rejected, because a
negative in-flight allowance has no meaning and E5 already says zero is a legal,
recoverable state.

**Why a clamp and not an error:** an error here would make an at-least-once
sender retry an acknowledgement forever, for the same reason E7 acks a duplicate
completion. The subscriber gets the window the publisher is willing to give and
can observe it; it is not punished for asking.

**This mirrors the Pub/Sub API**, where the number of events a client may
request per fetch is bounded by the service, not by the client.

**Guards** I7. **Status: `DECIDED`** — _added after the audit; see Amendments._

### E10 · What happens when an acknowledgement grants FEWER credits than are in flight?

**→ The subscriber pauses, legitimately, and recovers by acknowledging what it
already has.** No entry is dropped and no state is wedged.

`deliver` computes `credits - inFlight`, so a grant below the outstanding count
makes the available window zero or negative and nothing further is sent. That is
**E5's pause, reached from the other direction** — and it is the correct
behaviour, because a subscriber narrowing its own window is exactly the
backpressure signal the mechanism exists to carry.

**What had to be checked rather than assumed** is that the pause is
_recoverable_. It is: the entries counted in `inFlight` have already been
delivered, so the subscriber can always acknowledge them, and each ack lowers
`inFlight`. There is no state in which the subscriber needs credit in order to
earn credit.

**Else, clamping the grant up to `inFlight`:** that would silently overrule a
subscriber that is deliberately slowing down — the one thing E6 says the
publisher must not do.

**Else, leaving it undocumented:** the pause is indistinguishable from a
publisher that has nothing to send, so an operator debugging a stalled
subscriber has no way to tell "it asked for this" from "something is broken".
That is why the log counts how many grants it has clamped.

**Guards** I7. **Status: `DECIDED`** — _added after the audit; see Amendments._

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

**Now implemented, and the `Else` clause is what it used to be.** Every caller
hardcoded `livenessBoundN`, every corpus passed `quiesced: false` on every
event, and `checkI6` therefore returned on its first line for all 2,000
histories. I6 had never fired on a real run.

**What made it harder than a missing loop, and is the part worth reading.**
Under C5 reclamation is lazy — no sweeper, an expired lease is reclaimed by "the
next claimant". So if the workload simply stops, **nothing reclaims anything and
in-flight never reaches zero**: admit one run, advance ten thousand ticks, call
nothing, and `totalClaimed` is still 1. In that world I6's "drains within N
ticks" is not uncalibrated, it is FALSE, and no choice of N fixes it.

So quiescence is defined as what it means operationally: **new work stops, the
system keeps being asked.** Each tick of the drain issues one request, and
`admit` reclaims expired leases before it does anything else — including before
it looks the tenant up, so a REFUSED request drives reclamation exactly as a
granted one does. That is C5's "next claimant" in its weakest form, it adds no
fourth operation and no sweeper, and `controlPlane.test.ts` pins the ordering it
relies on.

**The calibration, as measured** (`test/quiescence.test.ts`, 200 fault-injected
seeds): **198 of 200 reach quiescence still holding capacity**, drains run from
1 to **40 ticks**, and the longest is exactly `leaseTicks`. N is computed as the
smallest multiple of ten strictly above the observed max — **50** — and both
sides of this row are then asserted against it: 40 ≤ 50, and 40 ≥ 25. The
mechanism behind the number is stated rather than merely measured: the last
claim taken before quiescence expires one lease later, and the next arriving
request reclaims it.

**Non-vacuity is asserted too**, because a calibrated bound that nothing can
violate is the same failure in a smarter costume: the same harness run with
N = 1 must produce I6 violations, and a plane whose leases never expire must
produce them at any N.

**Guards** I6. **Status: `DECIDED` (calibrated — see the note above)**

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

The rule at the top of this file is that a frozen row is never edited in place —
an appended, dated row is the thing git ordering makes credible. The file is
still `DRAFT`, so editing has been legal; the log below exists so that the
edits are visible without reading `git log -p`, which is the only reason the
rule was written.

| Date       | Row     | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-08-16 | **B6**  | Added — completion is terminal and frees capacity. Written **after** `src/policy/` existed, in commit `2bc4055` (M4), in response to the differential catching the gap (L2). It was inserted into section B rather than logged here, so the file read as if all 37 original rows were pre-implementation. They were: `3dc64c8` (SEMANTICS.md) is an ancestor of `c9ebbd5` (the control plane). B6 is the one row that is not, and it now says so here. |
| 2026-09-20 | **C4**  | Corrected — the row asserted that lease renewal "exists". There is no `renew` operation. The recommendation stands; the claim that it was implemented did not.                                                                                                                                                                                                                                                                                         |
| 2026-09-20 | **C6**  | Added — the fencing token applies to every path that frees a slot, not only `release()`. Resolved silently and wrongly until the audit (L10).                                                                                                                                                                                                                                                                                                          |
| 2026-09-20 | **A8**  | Added — I4's "expected" side is scoped to the current window (L11, L12, L13).                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-09-20 | **A9**  | Added — admission is idempotent per `runId`, and a completed id is not re-admissible. Found by connecting the fault injector to the control plane, which immediately fired I4 (L20, L21).                                                                                                                                                                                                                                                              |
| 2026-09-20 | **F3**  | Corrected — the calibration this row requires does not exist; `livenessBoundN` is hardcoded and the corpus never quiesces, so I6 is the vacuous invariant F3's own `Else` clause warns about. Open work, not a fix.                                                                                                                                                                                                                                    |
| 2026-09-20 | **B7**  | Added — precedence among simultaneous refusals. Neither document nor test fixed it, so both engines derived it from the same unwritten decision and already disagreed on one request no corpus can generate (L23).                                                                                                                                                                                                                                     |
| 2026-09-20 | **A10** | Added — a released or expired identity is re-admissible as a FRESH claim. A9's "still live" was implemented as an existence check that was always true (L22).                                                                                                                                                                                                                                                                                          |
| 2026-09-20 | **A11** | Added — the credit ledger is a function of virtual time, not of traffic. The window rolled only inside `admit`, so the counter described the epoch of the last admission (L25).                                                                                                                                                                                                                                                                        |
| 2026-09-20 | **C7**  | Added — the path that GRANTS a slot validates the fencing token, not only the three that free one. C6 was written and then under-applied (L22).                                                                                                                                                                                                                                                                                                        |
| 2026-09-20 | **E9**  | Added — a subscriber's credit grant is a request, bounded by the publisher. `acknowledge` assigned it straight through, so flow control constrained only the subscribers that chose to be constrained.                                                                                                                                                                                                                                                 |
| 2026-09-20 | **E10** | Added — an acknowledgement granting fewer credits than are in flight pauses, legitimately and recoverably. Previously undocumented behaviour, now pinned.                                                                                                                                                                                                                                                                                              |
| 2026-09-20 | **C8**  | Added, and C5's `Known cost` corrected with it — the expired-but-unreclaimed window is NOT externally invisible; a release inside it succeeds. Found by extending mutation to `src/oracle` (L28).                                                                                                                                                                                                                                                      |
| 2026-09-20 | **F3**  | Implemented — N is calibrated at 50 from a 200-seed quiescence corpus whose longest drain is 40 ticks, asserted from both sides. The row had said this was required since it was written.                                                                                                                                                                                                                                                              |
