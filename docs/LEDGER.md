# LEDGER.md — real findings

Bugs the harness caught that nobody planted. This is the artifact that matters:
a test suite's value is measured by what it found, not by how many assertions it
contains.

Planted mutants live in `MUTATION.md` and are **not** listed here. Promoting a
planted bug to a "discovery" would make this document worthless, and an
interviewer will ask which is which.

| #   | Found by                          | Severity       | What                                                                           |
| --- | --------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| L1  | Invariant corpus, 2,000 histories | 🔴 checker     | **I5 fired on correctly-refused stale releases**                               |
| L2  | Differential, seed 1              | 🔴 spec gap    | **Nothing said whether completion releases the slot**                          |
| L3  | Differential, seed 101            | 🟠 reference   | **Rejected-then-cancelled runs were billed for credit**                        |
| L4  | Mechanical mutation               | 🟠 dead code   | **`slot.released` never set true — the double-release branch was unreachable** |
| L5  | Mechanical mutation               | 🟡 dead code   | **`slot.runId` written five times, read never**                                |
| L6  | Mechanical mutation               | 🟠 correctness | **Every duplicate completion answered `replayId: 0`**                          |

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
