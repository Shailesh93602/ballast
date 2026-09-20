# LEDGER.md — real findings

Bugs the harness caught that nobody planted. This is the artifact that matters:
a test suite's value is measured by what it found, not by how many assertions it
contains.

Planted mutants live in `MUTATION.md` and are **not** listed here. Promoting a
planted bug to a "discovery" would make this document worthless, and an
interviewer will ask which is which.

**L1–L9 were found by the harness. L10–L19 were found by auditing the harness**
— reading what the oracles were actually fed rather than what their field names
said they were fed. The distinction is stated because it is the honest one, and
because the ratio it produces is the most useful thing in this file: twelve of
twenty-one findings were in the checking apparatus, not in the system under test.

| #   | Found by                          | Severity       | What                                                                                                            |
| --- | --------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| L1  | Invariant corpus, 2,000 histories | 🔴 checker     | **I5 fired on correctly-refused stale releases**                                                                |
| L2  | Differential, seed 1              | 🔴 spec gap    | **Nothing said whether completion releases the slot**                                                           |
| L3  | Differential, seed 101            | 🟠 reference   | **Rejected-then-cancelled runs were billed for credit**                                                         |
| L4  | Mechanical mutation               | 🟠 dead code   | **`slot.released` never set true — the double-release branch was unreachable**                                  |
| L5  | Mechanical mutation               | 🟡 dead code   | **`slot.runId` written five times, read never**                                                                 |
| L6  | Mechanical mutation               | 🟠 correctness | **Every duplicate completion answered `replayId: 0`**                                                           |
| L7  | Mutation run on a red suite       | 🔴 harness     | **The mutation harness reported 100% because the suite already failed**                                         |
| L8  | Writing a test for a mutant       | 🟠 dead code   | **The retry-limit branch was unreachable — contention stopped after attempt 1**                                 |
| L9  | Hand-applying a "survivor"        | 🟠 harness bug | **The negation operator didn't negate — vacuous mutants read as suite gaps**                                    |
| L10 | Differential, 200-event histories | 🔴 correctness | **`complete()` and `cancel()` freed a slot with no fencing token — a stale claimant evicted the live owner**    |
| L11 | Reading the corpus's own wiring   | 🔴 checker     | **I4 compared a map to itself** — the corpus passed `creditsSpentMap()` as BOTH of its inputs                   |
| L12 | Un-aliasing I4                    | 🟠 reference   | **The "independent recomputation" of credit was not window-scoped**, so it measured a different quantity        |
| L13 | Measuring the corpus's reach      | 🟠 corpus      | **0 of 2,000 histories ever crossed a window boundary** — max vtime 85 against `windowTicks` 100                |
| L14 | Auditing the retention guard      | 🟠 correctness | **A fully-evicted log answered "nothing new" instead of `retention-exceeded`**                                  |
| L15 | `grep -r eslint test/`            | 🔴 harness     | **DETERMINISM.md described a lint fixture that did not exist** — the perimeter had never been watched fire      |
| L16 | Reading the determinism guard     | 🔴 harness     | **The 1,000-seed guard only ever ran `NaivePolicy`** — the control plane had no determinism guard at all        |
| L17 | Auditing the claims tests         | 🟠 harness     | **"38 of 60" was asserted as a literal in four places and computed in none**                                    |
| L18 | Auditing the shrinker's tests     | 🟠 harness     | **The only S3 test asserted nothing on the path it actually takes**                                             |
| L19 | Parse-checking the mutant corpus  | 🟡 harness     | **3 of 165 mutants do not parse** and were scored as kills                                                      |
| L20 | Grepping for `Substrate`          | 🔴 harness     | **The fault injector was connected to nothing** — the control plane was never driven by the substrate that lies |
| L21 | The fault-injected corpus, seed 1 | 🔴 correctness | **A retried admit took a second slot and spent a second credit** for one logical run                            |

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

## L4 · A guard on a flag that nothing ever set

**Found by:** the first mechanical-mutation run (M5 tier 2, 116 mutants, commit
`f2bcfc2`) — `delete:statement` survivors at every `released = false`
assignment.

**Symptom:** deleting `s.released = false`, `free.released = false` and
`slot.released = false` — three separate sites — changed no observable
behaviour. The suite could not tell whether the field existed.

**Cause:** `slot.released` was assigned `false` in four places and `true` in
none. So `if (slot.released)` — the branch that answered `already-released` and
counted double-release attempts — was unreachable, and the `already-released`
reason in the public `ReleaseOutcome` union could never be returned. A second
release of the same slot fell through to the `tenant === null` check and
answered `not-held`.

**Why it matters more than "dead code":** the request was refused either way,
so no test failed and no invariant fired. But a reader reasoning about
double-release would have concluded it was handled by that flag, and been wrong
about how. A field that looks load-bearing while doing nothing is a claim the
type-checker co-signs. No behavioural test can see it from outside; deleting a
statement and watching nothing change is the only instrument that does.

**Fix:** field, branch and reason all removed. A slot with no tenant is not
held, which covers already-released, never-claimed and reclaimed-after-expiry
alike — one observable state, one answer. `ReleaseOutcome.reason` is now
`"stale-token" | "not-held"`, and the `Slot` definition in
`src/policy/controlPlane.ts` carries a note saying why the field is absent, so
it is not re-added as an obvious improvement.

**Regression:** none for the dead field itself — that is what dead means.
Double release as a _behaviour_ is covered by `test/mutants.test.ts` → _"M2:
release runs twice on an error path"_ and `test/mutationGaps.test.ts` → _"a
second release is detected"_.

---

## L5 · State that was written and never read

**Found by:** the same mutation pass as L4, while `Slot` was being cleaned up.

**Symptom:** `slot.runId` was assigned in five places — on admit, on release,
on lease expiry, on completion and on cancel — and read in none. Every
`delete:statement` mutant at one of those sites is equivalent to the original.

**Cause:** run identity lives on `RunState` and in the decision log; the copy on
the slot was carried along from an early draft and nothing was ever pointed at
it.

**Severity:** the lowest in this ledger. No behaviour depends on it. It is here
because it is the same shape as L4 without even the misleading branch: state
that exists only to be maintained, and a mutation score that would count each
write as an "uncovered" site forever.

**Fix:** removed, and recorded in the same `Slot` note as L4.

**What the record does not show.** The survivor table committed with the fix
(`docs/MUTATION.md` at `f2bcfc2`) was generated part-way through the change —
it still lists the three `released = false` deletions but no `runId` site. So
whether `runId` was first flagged by a listed survivor or by reading the struct
while removing `released` is not recoverable from the history. The commit
message attributes both to the same pass, and that attribution is the only
record.

**Regression:** none — dead state has no observable behaviour to assert.

---

## L6 · Every duplicate completion answered `replayId: 0`

**Found by:** the same mutation pass. Flipping the comparison inside the
duplicate-completion lookup changed nothing — the signature of code whose result
is never used, or always the same.

**Symptom:** a duplicate `complete` — the at-least-once case SEMANTICS E7 exists
for — was acknowledged with `ok: true, duplicate: true` and `replayId: 0`.
Replay ids start at 1; position 0 is never assigned.

**Cause:** the lookup ran through `findRunForId`, a private helper that
unconditionally returned `undefined`, so the `.find(...)` over the log's
assigned ids never matched and `existing ?? 0` always fell through to 0. The
endpoint answered `ok: true`, so nothing looked wrong.

**Why it is the observable one of the three:** the point of handing out a replay
id is that the caller can correlate an acknowledgement to a log position and
resubscribe from it. A duplicate ack carrying a position that does not exist is
worse than an error — it is a wrong answer delivered with a success code. The
first `complete` was tested; the second was tested for `duplicate: true` and for
not re-applying the effect (I8). Nobody had asserted which id the duplicate
carried.

**Fix:** `RunState` now stores the `replayId` assigned at completion, and a
duplicate echoes it. The helper is gone.

**Regression:** `test/mutationGaps.test.ts` → _"kills the duplicate-completion
replayId mutant — duplicates echo the ORIGINAL id"_, which asserts the
duplicate's id equals the first ack's and that the first is greater than zero.

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

## L9 · The negation operator didn't negate

**Found by:** distrusting a survivor. A mutant the suite "could not kill" was
applied by hand — and the suite failed instantly, inside the very test written
to kill it.

**Symptom:** 20 untriaged survivors and an 87.3% score that would not move,
including `bool:negate-if` survivors at lines whose kill-tests demonstrably
worked.

**Cause:** the operator spliced `if (!` into the line without wrapping the
condition. `if (a !== b)` became `if ((!a) !== b)` — a boolean compared against
a non-boolean, which is always true. Every "negation" at a comparison site was
a vacuous mutant, surviving for reasons that had nothing to do with the suite.

**The red herring, kept honest:** the first hypothesis was Vite's mtime-keyed
transform cache serving the unmutated file to a run that rewrites the same path
many times a second. A cold-cache rerun reproduced all 20 survivors
byte-identically, so that claim was retracted from the runner's comments before
the real cause was found.

**Why it matters:** this is L7's lesson from the other side. L7 was the harness
unable to tell success from catastrophe; L9 is an operator quietly measuring
nothing. A mutation score is a measurement OF the harness as much as of the
suite, and a broken operator under-reads silently — the "gaps" it reports cost
real triage effort aimed at the wrong place. After fixing the operator and
triaging honestly: 158/165 killed (95.8%), ten new kill-tests, and every
survivor carrying an explicit equivalence or unreachability argument.

---

## L10 · The fencing token guarded one of the three doors

**Found by:** the differential, once the corpus was long enough to reach the
state it needs — an expired lease whose slot has been handed to someone else.
275 of 300 histories diverged. At the shipped length of 30 events, zero did.

**Symptom:** `impl=admitted` where `ref=rejected:pool-full` and
`ref=rejected:cap-exceeded`. The implementation believed it had capacity the
reference knew was taken.

**Cause:** three code paths free a slot — `release()`, `complete()` and
`cancel()`. Only `release()` validated a fencing token. The other two looked the
slot up by `run.slotId` and freed it. After a lease expired and the slot was
reclaimed by a different tenant, `run.slotId` still named that slot, so a stale
completion or cancellation evicted its **current, legitimate owner**:

```
alice admits            -> slot-0, token 1, lease to t=10
(t=20) bob admits       -> slot-0, token 2   (lease expired, slot reclaimed)
alice releases  (stale) -> refused: stale-token      <- the fence works
alice completes (stale) -> ok: true          <- and bob silently loses slot-0
bob releases his own    -> refused: not-held
```

**Why every oracle missed it.** I1 and I2 only fire when the pool goes **over**
its bounds; this pushes it under. I3 stayed balanced because `releasesDone` was
incremented alongside. I5 — the invariant whose entire subject this is — was fed
only by `release()`, because the plane chose which facts to hand the checker.
That is L1 one level up: it is not enough for the checker to judge raw facts
instead of the plane's self-assessment, if the plane still decides which facts
it is shown.

**And the planted mutant that should have caught it.** M3 is
_"fencing-token check skipped on release (SEMANTICS C1)"_. It hand-builds a
`CheckableState` containing a stale `acceptedReleases` entry and asserts I5
fires. It does. What it asks is _"would the checker catch a stale release if one
were reported?"_ — not _"does the plane report every stale release?"_ Ten of the
sixteen semantic mutants have that shape, and the file's own docstring described
all sixteen as "a small broken re-implementation", which they are not. The
corpus asked the fencing question of exactly one of the three doors, and was
green about it.

**Fix:** `RunState` carries the token it was granted; a single `freeSlotOf`
compares it against the slot's current token on every path, and reports the
release to the checker. With that in place the divergence count goes 275 → 0.

**Regression:** `test/controlPlane.test.ts` → _"C1/C4: a stale COMPLETE must not
evict the slot's current owner"_, the matching CANCEL case, and _"I5 judges
every path that frees a slot, not only release()"_.

---

## L11 · The invariant that compared a map to itself

**Found by:** reading `stateOf()` in the corpus rather than the checker.

**Symptom:** none. That is the finding.

**Cause:** two adjacent lines:

```ts
creditsSpent:    plane.creditsSpentMap(),
creditsExpected: plane.creditsSpentMap(),   // the same object
```

`checkI4` iterates `creditsSpent` and compares each entry against
`creditsExpected.get(tenant)`. Given one object for both, the comparison is
`x === x` — for every tenant, after every event, across all 2,000 seeds and
again in `controlPlane.test.ts`. I4 is documented as "the credit ledger is
exact. Integer arithmetic, no tolerance" and could not have failed.

`ControlPlane.creditsExpected()` — the method whose docstring reads
_"independent recomputation of credits, for I4's differential check"_ — was
called by exactly one unit test, itself written to kill a mutation survivor that
existed **because nothing called it**. The survivor was the signal; what it was
pointing at was never followed up.

**Why it matters:** this is the shared-spec blind spot arriving by the shortest
possible route. The documented risk was "the reference and the implementation
share an author". The actual failure was that the two halves of an invariant
shared an _object reference_.

**Fix:** the corpus passes `plane.creditsExpected()`. With the source otherwise
untouched, I4 fires on seeds 1–5 immediately.

---

## L12 · The independent recomputation measured a different quantity

**Found by:** un-aliasing L11, which turned I4 red.

**Symptom:** `tenant acme credits spent=0 but ledger expects 9`.

**Cause:** `creditsSpent` is reset on every tumbling-window roll (SEMANTICS A1).
`creditsExpected()` counted every run ever admitted, across all windows. The two
are equal only before the first boundary.

**Why nobody saw it:** two independent masks, either of which alone was
sufficient. L11 meant the comparison could not fire; L13 meant the corpus never
crossed a boundary anyway. Removing one would not have revealed it.

**Fix:** `RunState.claimedWindow`, and the recomputation counts only the current
window.

**Regression:** `test/controlPlane.test.ts` → _"I4: the independent
recomputation is window-scoped, like the counter it checks"_.

---

## L13 · The corpus never reached the regime it claimed to cover

**Found by:** measuring the maximum virtual time the 2,000 generated histories
actually reach.

**Symptom:** max vtime **85**, against `windowTicks` **100**. Zero of 2,000
histories rolled a window. Lease expiry followed by re-claim — the precondition
for a stale claimant existing at all — was likewise almost never reached at 40
events.

**Why it matters:** SEMANTICS A2 names this exact outcome in its own `Else`
clause — _"too large and the corpus never observes a window boundary, leaving
A1's burst behaviour untested"_ — and it had happened. The document predicted
the failure and nothing measured whether it had occurred.

**Fix:** histories run to 120 events, and two tests assert the corpus **reaches**
both regimes (>1,000 of 2,000 crossing a boundary; >100 seeds producing a slot
re-assignment). A corpus size is not coverage; the state it reaches is.

---

## L14 · The quietest answer to the worst case

**Found by:** auditing the `retention-exceeded` guard against SEMANTICS E2.

**Cause:** `if (cursor < this.oldestRetained && this.entries.length > 0)`. The
second clause inverted the guarantee at exactly the point it mattered: once
retention had drained the log to nothing, a subscriber holding an evicted cursor
was answered `{ ok: true, entries: [] }` — _"nothing new yet"_ — for events it
had permanently missed. E2 exists to forbid precisely that: a hole with no way
to discover it.

Reachable with the shipped config: `retentionTicks` is 500, and any quiet period
longer than that empties the log. The suite's own E1 test constructs the empty
case (`byAge.evict(100); expect(byAge.size).toBe(0)`) and then never reads from
it.

**Fix:** drop the clause. `oldestRetained` is already set to `nextId` on full
eviction, so a fresh subscriber on an empty log is still served — asserted from
both sides.

---

## L15 · A ban nobody had watched fire

**Found by:** `grep -r eslint test/`, which returned nothing.

`docs/DETERMINISM.md` said, and had said for five weeks:

> **The rules are tested.** A fixture containing all seven violation classes is
> linted and must produce seven errors inside the perimeter and zero outside it.
> A ban nobody has watched fire is a ban you do not have.

There was no fixture and no test. The determinism perimeter — described in the
same document as "a build error, not a code-review convention", and load-bearing
for the project's central claim — had never been observed to reject anything.
The document's own closing sentence is the diagnosis.

**Fix:** `test/determinismPerimeter.test.ts` lints a fixture of every banned
construct through the ESLint API, asserts it errors inside
`src/core|policy|oracle|sim`, asserts it does **not** under `test/` and
`src/cli/` (an exemption silently in force everywhere would make the rest
vacuous), and asserts `core/order.ts` keeps its sanctioned exception.

---

## L16 · The guard was pointed at the placeholder

**Found by:** reading `determinism.test.ts` for what it actually constructs.

Every one of the 1,000 seeds ran `NaivePolicy` — the M0 skeleton whose own
docstring says it _"is NOT the control plane and makes no correctness claim"_.
`ballast simulate` runs it too. So the headline claim, "1,000 seeds
byte-identical against the built artifact", was a statement about a fifty-line
toy with one counter and one RNG draw, while `ControlPlane`, `ReplayLog` and
`Substrate` had no determinism guard at all.

**The claim turned out to be true** — 500 control-plane seeds are byte-identical
run twice, 300 produce 300 distinct hashes, and the decisions do not depend on
the order the tenants were configured in. But an unguarded true claim is one
refactor from an unguarded false one, and "the test exercised something the
runtime does not load" is a failure this workspace has already paid for twice.

**Fix:** the same guard, pointed at the control plane, including the
construction-order check that `runSimulation` gets for free (it sorts its tenant
list) and `ControlPlane` does not.

---

## L17 · The number that asserted itself

**Found by:** auditing every figure quoted in the README for whether anything
produced it.

Almost all of them survived — the test count, the mutation score, the
killed/total, the semantic-mutant count, the corpus sizes and the "N of the M"
findings sentence are each derived. One was not. `38 of 60` appeared in
README.md, twice in `docs/FAIRNESS.md`, and as a literal regex inside
`readmeClaims.test.ts`. `fairness.test.ts` asserted only `starvedSeeds > 0`.

So the guard asserted that the README still said what the README said. Had the
policy changed and the real figure become 41, all 209 tests would have stayed
green while three documents quoted a number no run reproduced. `FAIRNESS.md` was
read by no test at all.

The measured value is, as it happens, still 38. That is luck, not a guard.

**Fix:** the measurement runs; both documents are asserted against its result;
and the negative check ("no other `N of 60` is lying around") is **built from**
the computed values with `new RegExp`, rather than written beside them — the
correction this workspace applied after `claims-consistency.test.ts` hardcoded
the very number it existed to catch going stale.

---

## L18 · The test that asserted nothing

**Found by:** running the shrinker's S3 scenario and printing the result.

```
S3 scenario: verified=true reason=- calls=7 trace=[3]
```

The test body was `if (!result.verified) { expect(...) }`. The shrink succeeds
on that input in 7 calls, never reaching the 40-call flake threshold, so the
single assertion was skipped on every run. The only test guarding S3 — the
property whose docstring explains that a flaky reproduction is not a
reproduction — passed whether or not S3 existed.

Three other shrink tests have the same conditional shape.

**Related:** the shrinker had never been run on a `RefEvent[]`. Every test
shrinks `number[]` against a synthetic predicate, which exercises ddmin and the
self-oracle but shows nothing about the piece the README offers as a debugging
tool working on the thing it is for.

**Fix:** the success path is asserted unconditionally, a second input actually
trips S3 and is asserted to be rejected, and the shrinker is pointed at a real
differential divergence — 60 events reduced to fewer than 10, verified
1-minimal, and checked to still be a legal history rather than a smaller pile of
events.

---

## L19 · A mutant killed by a syntax error was never a mutant

**Found by:** parsing all 165 generated mutants with esbuild before running any
of them.

Three do not parse. `delete:statement` removes one **line**, so deleting the
first line of a multi-line statement (`this.runs.set(runId, {`) leaves an
unbalanced brace. The harness scores a mutant KILLED when the suite exits
non-zero, and a syntax error does that before a single assertion runs — so three
kills measured nothing about the suite.

The honest score barely moves (155/162 = 95.7% against 158/165 = 95.8%). It is
recorded because the _class_ is the one this harness has already been burned by
twice: L7 was the harness unable to tell success from catastrophe, L9 an
operator measuring nothing. This is a third variant — a scoring rule that
rewards the harness for its own malformed output.

**Fix:** mutants that do not parse are excluded and listed, not counted.

---

## L20 · The fault injector was connected to nothing

**Found by:** `grep -rn Substrate src/ test/`.

`src/sim/substrate.ts` is 173 lines that model late responses, reordering,
duplicates, stale readiness reads, 5xx, timeouts, pod death and lost appends,
weighted toward the boundaries where the bugs live. Its docstring opens: _"A
control plane is only interesting because the thing underneath it is
unreliable."_ The README lists it in the layout as "the substrate that lies".
`controlPlane.ts` said the substrate "injects duplicate and reordered requests
to expose" the check-then-claim race.

It appeared in exactly two places:

1. `invariants.test.ts`, where it is tested **in isolation** — it produces
   faults at the configured rate, weights them toward boundaries, and can lie
   about readiness. Wired to nothing.
2. `khatago.test.ts`, where the only fault consulted is `pod-death`. The other
   seven kinds are drawn and discarded.

**The control plane was never handed a single fault.** `makeHistory` produces
clean, well-formed histories: unique run ids, no duplicate requests, no
reordering, no retried timeouts. `reportsReady`, `killPod` and `isActuallyDead`
have no caller outside the substrate's own unit test, so SEMANTICS C3 — _"may
any invariant depend on a readiness poll being truthful? No. Every invariant
must hold even when every readiness read is a lie"_ — was asserted about a
system that never reads readiness at all.

**Why it matters:** KG2 says that finding zero unplanted violations means the
fault injector is too weak, and an injector connected to nothing is the limiting
case. It also explains L10's shape — the only way the old corpus could produce a
stale claimant was to get lucky with lease expiry, which needed histories three
times longer than the ones being run.

**Fix:** `test/faultInjection.test.ts` applies the substrate's faults to the
DELIVERY of every operation — duplicate, timeout-then-retry, reorder, delay,
pod-death-drops-the-terminal-op — and checks all eight invariants after every
one, over 500 seeded histories. The first assertion in the file is that the
injector is connected: faults are counted, the honest arm injects zero, and the
faulted stream is longer than the honest one. `stale-ready` and `lost-append`
are explicitly NOT modelled, and the file says so — an injector whose faults
quietly do nothing is worse than a smaller one that does.

**It found L21 on seed 1.**

---

## L21 · A retried admit was a second run

**Found by:** the fault-injected corpus, immediately — seeds 1, 2, 3, … all
violated I4 within the first history.

```
tenant globex credits spent=7 but ledger expects 6      (seed 1)
tenant globex credits spent=5 but ledger expects 4      (seed 2)
```

**Cause:** `admit(now, tenant, runId)` had no idempotence. A duplicated or
retried admit for the same `runId` — which is what `duplicate` and `timeout`
both produce, and what at-least-once delivery makes routine — took a **second
slot** and spent a **second credit**, then overwrote `RunState` with the new
slot. The first slot was orphaned until its lease aged out, and one logical run
was billed twice.

SEMANTICS A7 asks exactly this question about completions and answers "no, a
duplicate must not debit twice". Nobody asked it of admissions.

**The chain worth noting.** I4 is what caught this, and I4 could not fire at all
until L11 was fixed — the corpus was passing `creditsSpentMap()` as both of its
inputs. So: making the oracle independent (L11), giving the recomputation the
right definition (L12), extending the corpus's reach (L13) and connecting the
injector (L20) were each individually necessary before a real bug in the system
under test became visible. Four apparatus fixes to surface one correctness bug
is the honest cost of an oracle that had stopped grading.

**And a second bug it exposed on the way.** Re-admitting a runId whose run had
already COMPLETED built a fresh `RunState` with `effectApplied: false`, so
completing it again applied the effect for that identity a **second time** — an
I8 violation reachable through that door and no other. A9 now refuses it with
`run-already-terminal`.

**Fix:** admission is idempotent per `runId` (SEMANTICS A9). A duplicate of a
live claim echoes the existing grant — acked, not errored, for E7's reason. A
completed id is refused. The reference oracle counts credit per claimed RUN
rather than per admit EVENT, which is the same correction on the other side.
