# LEDGER.md — real findings

Bugs the harness caught that nobody planted. This is the artifact that matters:
a test suite's value is measured by what it found, not by how many assertions it
contains.

Planted mutants live in `MUTATION.md` and are **not** listed here. Promoting a
planted bug to a "discovery" would make this document worthless, and an
interviewer will ask which is which.

| #   | Found by                          | Severity       | What                                                                            |
| --- | --------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| L1  | Invariant corpus, 2,000 histories | 🔴 checker     | **I5 fired on correctly-refused stale releases**                                |
| L2  | Differential, seed 1              | 🔴 spec gap    | **Nothing said whether completion releases the slot**                           |
| L3  | Differential, seed 101            | 🟠 reference   | **Rejected-then-cancelled runs were billed for credit**                         |
| L4  | Mechanical mutation               | 🟠 dead code   | **`slot.released` never set true — the double-release branch was unreachable**  |
| L5  | Mechanical mutation               | 🟡 dead code   | **`slot.runId` written five times, read never**                                 |
| L6  | Mechanical mutation               | 🟠 correctness | **Every duplicate completion answered `replayId: 0`**                           |
| L7  | Mutation run on a red suite       | 🔴 harness     | **The mutation harness reported 100% because the suite already failed**         |
| L8  | Writing a test for a mutant       | 🟠 dead code   | **The retry-limit branch was unreachable — contention stopped after attempt 1** |

---

## L1 · The checker trusted the thing it was checking

**Found by:** the 2,000-history invariant corpus, immediately on first run.

**Symptom:** I5 reported `slot slot-3 was released by a holder with a stale
fencing token` on dozens of seeds — against a control plane that was _correctly
refusing_ every one of those releases.

**Cause:** `ControlPlane.release` recorded each rejected stale attempt into a
`staleReleases` array, and the checker treated any entry as a violation. So the
fencing token doing exactly its job was scored as a failure.

**Why it matters more than it looks.** The checker was consuming the plane's own
_self-assessment_ rather than raw facts. That is the same class of error as a
test asserting `expect(mock).toHaveBeenCalled()` — it verifies the code did what
the code says it did. Had the mutant in M5 removed the token check entirely, the
plane would simply have stopped recording attempts and I5 would have gone
**quiet**, so the mutant would have survived. The invariant would have looked
strongest exactly when it had stopped working.

**Fix:** the plane now records `acceptedReleases` — for each release it _allowed_,
the slot, the token presented, the token actually held, and how many releases had
already happened in that generation. The checker compares those and judges. It no
longer asks the plane whether it thinks it behaved.

**Regression:** `test/invariants.test.ts` → _"I5 stays SILENT when a stale release
was correctly REFUSED"_.

---

## L2 · A spec gap the differential caught before it could hide

**Found by:** the implementation-vs-reference differential, seed 1, event 9.

**Symptom:** the implementation rejected admits with `cap-exceeded` / `pool-full`
while the reference admitted them. The two disagreed about how much capacity was
in use.

**Cause:** **nothing in `SEMANTICS.md` said whether recording a completion
releases the run's slot.** The implementation held it until an explicit release
or lease expiry; the reference treated completion as terminal and freed it.
Neither was wrong against the spec, because the spec was silent.

**Why this is the project's thesis in miniature.** This is exactly the failure
mode `SEMANTICS.md`'s preamble warns about — an ambiguity nobody asked out loud
— and it is the case where the design _worked_. The two halves were built from
the same document but not the same assumption, so they **disagreed instead of
being confidently wrong together**. Had one author written both in one sitting,
they would have matched, the differential would have been green, and the system
would have silently leaked capacity: finished runs occupying pool slots until
their leases aged out.

**Fix:** `SEMANTICS.md` amendment **B6** — completion is terminal and frees
capacity atomically with recording the effect. Appended as a dated amendment
rather than edited into B1–B5, because the value of the git ordering is that it
cannot be rewritten. Both engines updated to match.

---

## L3 · The reference billed credit that was never spent

**Found by:** the differential, seed 101, event 23 — after L2 was fixed.

**Symptom:** the reference refused an admit with `no-credit` that the
implementation correctly allowed. `initech` had spent 7 of 8 credits; the
reference believed 8.

**Cause:** the reference decided "did this admit spend a credit?" by asking
whether the run appeared in its `status` map. But the `cancel` branch inserts a
runId into `status` **even for a run whose admit was rejected** — so a
rejected-then-cancelled run was counted as having consumed a credit it never got.

**Why it survived review:** `status.has(runId)` reads like "this run exists",
and it does. It just does not mean "this run took a slot". The two coincide for
every run except the rejected-then-cancelled case, which is rare enough that a
hand-written test would not have thought to construct it — and common enough
that a 300-history corpus hit it at seed 101.

**Fix:** the reference now tracks `actuallyClaimed`, a set populated only when an
admit is accepted, and keys credit off that.

**Worth stating plainly:** this bug was in the _oracle_, not the system. Two of
the three findings so far are in the checking apparatus rather than the thing
being checked. That is not embarrassing, it is the expected distribution — the
oracle is newer and less exercised than the code it judges, and finding its bugs
early is precisely why the planted-bug arms and the non-vacuity controls exist.

---

_Corpus at time of writing: 2,000 invariant histories × up to 40 events, 300
differential histories × 30 events, 1,000 determinism seeds × 3 runs._

---

## L7 · The harness could not tell success from catastrophe

**Found by:** running `scripts/mutate.mjs` while the suite was red.

A mutant is judged **killed** when the suite fails with it applied. That is the entire mechanism. It
has an obvious corollary that nothing in the harness accounted for: **if the suite already fails,
every mutant is killed**, and the report reads

```
killed 165/165   mutation score 100.0%
```

This happened for real. A stale test count in the README made three assertions fail, and the run
printed a flawless score while genuine survivors went unrecorded.

**The number that should have raised an alarm was the reassuring one.** A 100% mutation score is
implausible; 83% invites investigation and 100% invites celebration, which is precisely backwards.

**Fix:** run the suite once before mutating anything and refuse to proceed if it is red, with an error
that explains why the result would have been meaningless.

> **Why this belongs in the ledger and not in a commit message.** L1 was a checker consuming the
> system's own account of itself. This is the same failure one level further out: **the harness that
> judges the tests could not tell "the tests are excellent" from "the tests are broken."** Every layer
> that grades another layer needs someone grading it, and eventually that someone is you asking what
> the output would look like if the tool were wrong.

---

## L8 · A branch that could never run

**Found by:** trying to write a test for a surviving mutant on `attempt <= MAX_RETRIES`.

The optimistic-concurrency arm of `flashSale.ts` retries up to five times and refuses if it exhausts
them. The mutant changed `<=` to `<` and survived — so the test suite could not tell four retries
from five.

The reason turned out to be better than a missing assertion: **the branch was unreachable.**
Interleaved buyers all committed during attempt 1, so the compare-and-set could lose at most once and
then always won. A reachability probe over every stock and buyer-count shape confirmed it never
fired.

Dead code dressed as defensive programming — the same shape as L4, found the same way.

**Fix, and the choice worth recording:** the branch was kept and _the model was corrected_. Deleting
it would have been defensible on the evidence — it genuinely never ran — but the retry bound is
right, and the reason it never ran was that the model let contention politely stop after the first
attempt. A busy row stays busy. Contention is now sustained, one contender committing per attempt,
and the probe finds exhaustion at stock=5 with 6 buyers.

> **The lesson:** when a mutant survives, the interesting question is not always "which assertion is
> missing." Sometimes it is "why does this code never execute", and the answer is that the _model_ is
> too polite rather than the test being too weak.
