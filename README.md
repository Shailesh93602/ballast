# BALLAST

A deterministic simulation of a **multi-tenant session control plane** — per-tenant
parallel caps, a rolling credit window, a finite warm pool, leases over a
substrate that lies, and an at-least-once completion channel built as a replay
log with opaque replay IDs and subscriber-driven credit flow control.

One integer seed in. One byte-identical decision log out.

**Zero runtime dependencies.** `git clone && npm install && npm test`.

---

## What it found

A test suite is worth what it caught, not what it asserts. These are real bugs
that nobody planted — L1–L9 caught by the harness, L10–L21 caught by auditing
the harness itself. Planted mutants live in [`MUTATION.md`](docs/MUTATION.md)
and are deliberately kept out of this list.

| #       | Found by                          | What                                                                                                                                                                                                                                                                  |
| ------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L2**  | Differential oracle, seed 1       | **A spec gap.** Nothing said whether completing a run releases its slot. The implementation held it until lease expiry; the reference freed it. Neither was wrong — the spec was silent.                                                                              |
| **L1**  | Invariant corpus                  | **The checker trusted the thing it was checking.** I5 fired on stale releases that were _correctly refused_, because it read the plane's self-assessment instead of raw facts.                                                                                        |
| **L3**  | Differential, seed 101            | **The reference billed credit that was never spent** — it asked whether a run appeared in the status map, but `cancel` inserts a runId even for a _rejected_ admit.                                                                                                   |
| **L6**  | Mechanical mutation               | **Every duplicate completion answered `replayId: 0`** — the lookup ran through a helper that unconditionally returned `undefined`, while the endpoint answered `ok: true`.                                                                                            |
| **L4**  | Mechanical mutation               | **An unreachable branch pretending to be a guard.** `slot.released` was assigned `false` in four places and `true` in none.                                                                                                                                           |
| **L5**  | Mechanical mutation               | Dead state: `slot.runId` written five times, read never.                                                                                                                                                                                                              |
| **L7**  | Mutation run on a red suite       | **The harness reported 100% because the suite already failed.** A mutant is killed when the suite fails — so if it fails first, every mutant is killed. The reassuring number was the alarming one.                                                                   |
| **L8**  | Testing a surviving mutant        | **A retry-limit branch that could never run**, because contention in the model stopped after attempt 1. The fix corrected the model, not the branch — a busy row stays busy.                                                                                          |
| **L9**  | Hand-applying a "survivor"        | **The negation operator didn't negate.** `if (!` spliced without parens turned `if (a !== b)` into `(!a) !== b` — always true — so vacuous mutants "survived" and the score under-read at 87.3%. Fixed and honestly triaged: 95.8%, every survivor argued.            |
| **L10** | Differential, long histories      | **The fencing token guarded one of three doors.** `release()` validated it; `complete()` and `cancel()` freed the slot by id. A stale claimant evicted the slot's **current owner** — and I1/I2/I3 all stayed green, because the pool moved further under its bounds. |
| **L11** | Reading the corpus's wiring       | **I4 compared a map to itself.** The corpus passed `creditsSpentMap()` as both `creditsSpent` and `creditsExpected`, so "the credit ledger is exact" was `x === x` for every event of all 2,000 seeds.                                                                |
| **L12** | Un-aliasing I4                    | **The "independent recomputation" measured a different quantity** — it counted runs across all windows while the counter it checked resets on every window roll.                                                                                                      |
| **L13** | Measuring the corpus's reach      | **0 of 2,000 histories ever crossed a window boundary** (max vtime 85 against `windowTicks` 100). SEMANTICS A2 names this exact outcome in its own `Else` clause.                                                                                                     |
| **L14** | Auditing the retention guard      | **A fully-evicted log answered "nothing new"** instead of `retention-exceeded` — the silent hole E2 exists to forbid, at the one moment it mattered.                                                                                                                  |
| **L15** | `grep -r eslint test/`            | **DETERMINISM.md described a lint fixture that did not exist.** The perimeter enforcing the central claim had never been watched fire — the failure that document's own last sentence names.                                                                          |
| **L16** | Reading the determinism guard     | **The 1,000-seed guard only ever ran `NaivePolicy`**, the M0 placeholder. The control plane had no determinism guard at all. (It is deterministic — but nothing was checking.)                                                                                        |
| **L17** | Auditing the claims tests         | **"38 of 60" was written in four places and computed in none.** The guard asserted that the README still said what the README said.                                                                                                                                   |
| **L18** | Auditing the shrinker's tests     | **The only S3 test asserted nothing** on the path it actually takes — the shrink succeeds, so the lone `if (!verified)` assertion was skipped every run.                                                                                                              |
| **L19** | Parse-checking the corpus         | **3 of 165 mutants do not parse** and were scored as kills. A mutant killed by a syntax error measures nothing about the suite.                                                                                                                                       |
| **L20** | `grep -rn Substrate`              | **The fault injector was connected to nothing.** 173 lines modelling duplicates, reordering, stale readiness and pod death — used by its own unit test and, for one fault kind, by KhataGO. The control plane was never handed a single fault.                        |
| **L21** | The fault-injected corpus, seed 1 | **A retried admit was a second run.** At-least-once delivery makes a duplicate admit routine; it took a second slot and spent a second credit for one logical run. A7 settled this for completions and nobody asked it of admissions.                                 |
| **L22** | Reading A9 against the code       | **The fourth door.** C6 fenced every path that FREES a slot. The path that GRANTS one checked only that the slot EXISTS — always true, since slots are never removed — so a retry was answered with a slot the caller did not hold, and after a reclaim, with another tenant's. |
| **L23** | Writing the precedence row        | **Both engines derived an unwritten order, and already disagreed.** An unknown tenant naming a cancelled runId got `unknown-tenant` from one and `cancelled-before-start` from the other. Every corpus draws tenants from the config, so nothing could ask.                     |
| **L24** | Grepping the checker's own inputs | **A declared oracle input that nothing wrote and no invariant read.** `slotOwnerToken` was passed as `new Map()` by every corpus — L5's dead state, one layer up, in the apparatus.                                                                                             |
| **L25** | Building the independent ledger   | **The credit ledger described the epoch of the last ADMISSION**, not the one containing `now`, because the window rolled only inside `admit`. Invisible to every admission decision, which is why it survived.                                                                  |
| **L26** | Asking what could kill an RNG mutant | **The determinism guard cannot tell a correct generator from a changed one.** Same-seed-twice, across-process and distinctness all hold for a wrong PRNG. The README's three hashes were checked by nothing.                                                                 |
| **L27** | The harness refusing to start     | **A mutant "killed" by a TIMEOUT was scored as a kill.** A timeout exits non-zero, and non-zero is how a kill is judged — so a busy machine inflated the score, invisibly. L7 and L19 twice removed.                                                                            |

Full write-ups: [`LEDGER.md`](docs/LEDGER.md).

Sixteen of the twenty-seven were in the **checker, the reference oracle or the harness**, not the
system under test — L1, L11 and L24 (the checker), L3, L12 and L23 (the reference oracle), L7, L9,
L15, L16, L17, L18, L19, L20, L26 and L27 (the guards, the fault injector and the mutation
harness). That ratio is the most useful thing this project
taught: every layer that grades another needs someone grading it, and eventually that someone is you
asking what the output would look like if the tool were wrong. Both numbers are counted from the
table in `LEDGER.md` by a test, so this sentence cannot drift from it again.

**L1–L9 were found by the harness; L10–L21 were found by auditing the harness; L22–L27 came from a
second audit asking a narrower question** — which decisions do the two engines share WITHOUT having
written them down? The first audit read what each oracle was actually handed, rather than what its
field names said it was handed. L11 is the one to
read: the documented risk was "the reference and the implementation share an author", and the actual
failure was that the two halves of an invariant shared an _object reference_. L13 is its twin — the
corpus could not have caught L12 even un-aliased, because no generated history ever reached tick 100.

**L21 is the payoff, and the honest cost.** Four apparatus repairs had to land before a real bug in
the system under test became visible at all: make I4's two inputs independent (L11), give the
recomputation the right definition (L12), extend the corpus far enough to reach a window boundary
(L13), and connect the fault injector to the thing it was supposed to be injecting into (L20). Then
seed 1 failed immediately. An oracle that has stopped grading does not announce itself — it reports
success.

**L2 is the one worth reading.** The two engines were built from the same
specification but not the same assumption, so they **disagreed instead of being
confidently wrong together**. Had one author written both in one sitting they
would have matched, the differential would have been green, and finished runs
would have silently occupied pool slots until their leases aged out.

That is the entire argument for [`SEMANTICS.md`](docs/SEMANTICS.md) existing —
and being committed — before a line of policy code.

**L23 is L2's shadow, and the reason the second audit happened.** L2 was lucky:
the two engines disagreed, so the differential caught it. L23 is the same class
of gap where they agreed — an order neither document nor test fixed, which both
halves resolved the same way for no better reason than one author and one
afternoon. **The differential compares the rejection reason, which made the
question look answered.** The useful question turned out not to be "what does
the oracle check" but **"which decisions do the two engines share that nobody
ever wrote down"** — and its answer cannot come from running anything, because
every test passes.

So the order lives in one place (SEMANTICS B7), a test **parses it out of the
document**, the reference resolves through it instead of short-circuiting, and
the implementation keeps its own source order. Three sources that must agree,
none of which can be moved quietly.

**L22 is what came of asking that question about the fencing token.** C6 says
every path that FREES a slot compares tokens; it enumerated three doors. The
path that GRANTS one was never asked, checked only that the slot existed —
always true — and handed a retrying tenant a slot another tenant owned. Three
corpora, eight invariants and a reference oracle were green against it, each for
a different structural reason, and all of them are listed in `LEDGER.md` because
the reasons are more useful than the bug.

---

## Prior art

The techniques here are not mine and are named rather than implied.

- **Deterministic simulation testing** is FoundationDB's approach, and TigerBeetle's.
- **Delta debugging** (`ddmin`) is Zeller & Hildebrandt, 2002.
- **Fencing tokens** for stale-claimant exclusion are Kleppmann's framing of the
  Redlock critique.
- The **replay-log contract** — opaque replay IDs, bounded retention,
  resubscribe-from-ID, subscriber credit — restates the shape of Salesforce's
  Pub/Sub API.

What is mine is the harness: the invariants, the way each oracle is checked
against its own vacuity, and the finding ledger.

---

## The design decisions worth arguing about

**Three operations.** `admit`, `release`, `complete`. That is the whole API, and
keeping it there is deliberate: every extra operation needs its own acceptance
testing, and breadth is what makes a project expensive to verify. The surface is
narrow so the depth behind it can be real — eight invariants, a reference oracle,
a mutation corpus and a shrinker, all pointed at three entry points.

**The cap is checked _inside_ the claim.** Splitting the check from the mutation
is the classic race: two admits both observe `inFlight = cap - 1`, both conclude
there is room, both proceed. The predicate is part of the write.

**Credit is debited at claim**, which makes the credit ledger and the concurrency
cap one mechanism rather than two that disagree. Debiting at admit bills for work
that may never run; debiting at completion cannot bound concurrency at all.

**A subscriber at zero credit pauses; it never drops.** A completion stream is a
_fold_ — the subscriber's view is the accumulation of every entry it has seen — so
dropping does not degrade that view, it corrupts it, permanently and silently.

**Credit decrements on acknowledgement, not on send.** Decrementing on send
measures what the publisher emitted rather than what the subscriber absorbed, so
a dead subscriber would never apply backpressure, which is the entire point.

Every one of these traces to a numbered row in [`SEMANTICS.md`](docs/SEMANTICS.md).

---

## What the oracles cannot do

Stated here rather than left to be discovered.

**The differential is blind to a shared misunderstanding.** The reference and the
implementation have one author and one specification. It validates
implementation-against-intent; it cannot validate intent-against-reality. If a
spec row is wrong, both halves are wrong together and the test passes. That is
why the invariants exist independently of it.

**A method on a class is not an oracle for that class.** I4's expected side used
to be `ControlPlane.creditsExpected()` — a recomputation that walked `this.runs`,
the same map `admit` writes. Two views of one piece of state can disagree about
their own consistency and about nothing else, so the entire class of bug where
the plane and its bookkeeping are wrong TOGETHER was outside I4's reach by
construction. That is not hypothetical: it is exactly what L22 did — a claim the
plane granted and never billed, missing from both sides at once. The expected
side is now rebuilt from the **event history** by the reference model, which
shares no state with the plane; L25 fell out of the change within minutes.

**And an oracle is only as independent as its INPUTS.** The blind spot above is
the one that gets written down; the one that actually happened was cruder. I4
was handed `creditsSpentMap()` as both the value and the expectation, so the
"exact, no tolerance" credit invariant was `x === x` for every event of all
2,000 seeds (L11). I5 was handed only the releases that `release()` chose to
report, so the two other paths that free a slot were outside its field of view
entirely — which is how L10 lived for five weeks under eight invariants, a
reference oracle and 165 mutants. **Check what each oracle is passed, not what
its field names say it is passed.**

**A corpus is worth what it REACHES, not what it runs.** 2,000 histories that
all stop at tick 85 do not test a window that rolls at 100 (L13). The two
regimes this corpus depends on — a window boundary, and a slot handed to a
second claimant — are now asserted to occur, because a corpus size is a
measure of cost, not of coverage.

**I8 is blind to a wrong identity.** It counts effects per identity, so keying a
dedup on the wrong field produces two rows each with a legitimate count of one.
Recorded as a test in `khatago.test.ts` rather than omitted.

**The KhataGO verification is of the PROTOCOL, not the implementation.** It shows
the mechanism is sound. It does not show that KhataGO's Prisma calls implement
the mechanism faithfully — that needs the real handler driven against a real
database, which is Tier B and has not run yet.

**A differential comparing REASONS still cannot see a shared order.** The
differential was strengthened to compare the rejection reason and not just the
admit/reject bit — which is strictly better, and which made rejection precedence
look covered while both engines derived it from the same unwritten decision
(L23). The lesson generalises past this repo: **strengthening an oracle can
disguise a blind spot as coverage.** The questions that find these are not
"what does the oracle check" but "what do both halves assume that nobody wrote
down", and no amount of running anything will answer that one.

**The claim protocol has no reaper.** A claimant that dies leaves its row stuck in
`PROCESSING` forever. Asserted as a test so it cannot quietly stop being true.

**I6 now fires on real runs, and the interesting part was not the loop.**
It used to be the honest gap here: `livenessBoundN` was hardcoded by every
caller and the corpus passed `quiesced: false` on every event, so `checkI6`
returned on its first line for all 2,000 histories. Adding a drain turned out to
expose something sharper — **under C5 reclamation is lazy, so if the workload
simply stops, nothing reclaims anything and in-flight never reaches zero.**
Admit one run, advance ten thousand ticks, call nothing: still held. "Drains
within N ticks" was not uncalibrated in that world, it was false, and no choice
of N would have fixed it.

Quiescence therefore means what it means operationally — **new work stops, the
system keeps being asked** — and the drain is driven by requests that `admit`
refuses, because it reclaims expired leases before it even looks the tenant up.
Measured over 200 fault-injected seeds: 198 reach quiescence still holding
capacity, the longest drain is **40 ticks (exactly one lease)**, and N is
computed as **50**, the smallest multiple of ten above it. Both sides of F3 are
asserted (40 ≤ 50 and 40 ≥ 25), and so is non-vacuity: the same harness at
N = 1 must produce violations.

---

## The flash-sale arm

`src/policy/flashSale.ts` models the classic never-oversell problem — N units,
far more buyers, consistency chosen over availability — as a third policy behind
the same checker. It is the same shape as this repo's admission control one
layer down: a per-tenant concurrency cap and a per-SKU stock count are both a
bounded resource under contention.

Three strategies differing **only** in how they claim a unit:

| Strategy             | Oversells?                          | Retries under contention         |
| -------------------- | ----------------------------------- | -------------------------------- |
| `read-then-write`    | **yes** — sells the last unit twice | 0 (it never retries)             |
| `conditional-update` | no                                  | 0 — there is no window to lose   |
| `optimistic-version` | no                                  | >0 — every loser redoes its work |

The interleaving is an **input**, not a race the test hopes to hit, so the
overselling replays byte-identically every run.

Two details the tests exist to pin down. Every read the naive strategy makes is
**correct at the moment it happens** — the bug is acting on it after it stopped
being true, which is why it survives review. And `oversold` is derived from the
recorded outcomes rather than from the strategy's own tally, because a strategy
that miscounts its sales must not be able to report zero.

`optimistic-version` is included precisely to argue against itself here: it is
correct and strictly more expensive, and for "subtract one if positive" a WHERE
clause already says everything. It earns its cost only when the update needs
logic a predicate cannot express.

### And against a real Postgres

The simulation names the race; `src/tierb/flashSaleReal.ts` confirms a real
database exhibits it. Same three strategies over `pg` (a dev-only dependency —
the library still has zero runtime dependencies), 200 concurrent buyers racing
for 5 units, judged by counting the rows rather than trusting any strategy's
tally. A representative local run (`npm run flash-sale:real` regenerates it —
nothing below is stored, so nothing below can go stale):

```
strategy             sold  refused  OVERSOLD  conservation err  retries   ms
read-then-write       200        0       195              -199        0   49
conditional-update      5      195         0                 0        0   11
optimistic-version      5      195         0                 0      748  103
```

The naive strategy sold two hundred of five units. The optimistic one is just
as correct as the conditional one and paid 748 retries and ~10x the wall time
for it — which is the actual trade-off the flash-sale question asks about.
The suite skips (loudly) when no local `khatago_ballast` database exists, so
CI stays honest without a Postgres service.

## Numbers

Every figure below is produced by a test in this repository. A CI job greps this
file for each one and fails if the run does not reproduce it.

- **1,000 seeds** byte-identical for the simulation spine, in-process and across
  a fresh process, against the built artifact — plus **500 seeds** for the
  control plane itself, which until this audit had no determinism guard at all
  (L16)
- The determinism ban list **watched firing**: every banned construct linted
  through a fixture, inside the perimeter and outside it (L15)
- **286 tests**
- **96.4% mutation score** over `src/policy`
  (161 of 167 mechanical mutants killed), plus 3 generated mutants excluded
  because they do not parse — a mutant killed by a syntax error was never a
  mutant (L19)
- **16 of 16** semantic mutants caught
- **2,000 invariant histories**, checked after _every_ event, and asserted to
  REACH the regimes they claim to cover — a window boundary, and a slot handed
  to a second claimant (L13)
- **300 differential histories**, compared on the rejection _reason_ and not
  only the admit/reject bit — and, because comparing the reason is not the same
  as agreeing on which reason WINS, **9 hand-built overlap scenarios** in which
  two or more refusal conditions hold at once, each asserting it reaches its
  overlap before asserting the order (L23)
- **200 quiescence seeds** driving I6, which until this round had never fired on
  a real run: 198 of them reach quiescence still holding capacity, the longest
  drain is 40 ticks, and the liveness bound N = 50 is **computed from that
  measurement** and asserted from both sides (SEMANTICS F3)
- **500 fault-injected control-plane histories** — duplicates, retried timeouts,
  reordering, delays and pod deaths, checked after every event (L20)
- I4's expected side rebuilt from the **event history**, not from a method on
  the class being checked (L22, L25)
- **500 KhataGO protocol runs** under the fault injector
- Fairness: per-tenant caps **1.000×** degradation; global FIFO starves a
  well-behaved tenant outright in **38 of 60** seeds

---

## Layout

```
src/core/      seeded PRNG, virtual clock, event queue, decision log, ordering
src/sim/       the substrate that lies (driven by test/faultInjection.test.ts)
src/policy/    the control plane, the replay log, KhataGO's claim protocol
src/oracle/    invariants, the reference scheduler, the shrinker
docs/          SEMANTICS · DETERMINISM · LEDGER · MUTATION · FAIRNESS
scripts/       the mutation harness
```

## See it work

Real output, not a screenshot — every command below is reproducible after
`npm install && npm run build`, and the hashes are the ones you will get.

**The same seed produces a byte-identical run, in separate processes:**

```console
$ node dist/cli/index.js simulate --seed 4711 --hash-only
1fe23d51bb0a8241f7f5fc2aed878692dc7329c7abcab7ecd46ee42e84b018ad

$ node dist/cli/index.js simulate --seed 4711 --hash-only
1fe23d51bb0a8241f7f5fc2aed878692dc7329c7abcab7ecd46ee42e84b018ad

$ node dist/cli/index.js simulate --seed 4712 --hash-only
9aae9611ee24b85de9d04933666f4fc043d0ade80c6c4dfed8a550957b307ebf
```

That is the whole premise in three commands. A concurrency bug that reproduces
on demand is a bug; one that does not is a research project.

**Record a trace and re-check it offline:**

```console
$ node dist/cli/index.js simulate --seed 4711 --out run.jsonl
$ node dist/cli/index.js replay --trace run.jsonl
records     39
tenants     acme, globex, initech
  admit           15
  reject          9
  release         15

structure   OK
```

`replay` is seedless and independent of the current source, so a shrunk failure
stays reproducible across the very edits you are making to fix it. `simulate`
cannot do that — it re-executes, so its answer changes the moment you touch the
policy.

**And it detects a trace that has been truncated or spliced:**

```console
$ head -20 run.jsonl > spliced.jsonl && tail -12 run.jsonl >> spliced.jsonl
$ node dist/cli/index.js replay --trace spliced.jsonl
...
7 structural problem(s):
  seq 27: seq is 27 but the record is at position 20 — the trace is not contiguous
  seq 28: seq is 28 but the record is at position 21 — the trace is not contiguous
  ...
$ echo $?
1
```

Non-zero exit, so it gates rather than merely reporting. A shrunk trace that
quietly lost records is worse than one that fails loudly — every conclusion
drawn from it is about a run that never happened.

## Running it

```bash
npm install
npm test                       # everything, ~4s
npm run gate                   # lint + type-check + test + build + format
node scripts/mutate.mjs        # mutation testing (slow — spawns a suite per mutant)
node dist/cli/index.js simulate --seed 4711 --out run.jsonl
node dist/cli/index.js replay --trace run.jsonl
```

`simulate` reproduces a run by re-executing it, so its answer depends on the
code being unchanged — the moment you edit the policy to investigate, the seed
stops reproducing the trace you were looking at. `replay` re-checks a **recorded**
trace instead: seedless, offline, and independent of the current source, so a
shrunk failure stays reproducible across the very edits you are making to fix it.
It exits non-zero on a structurally broken trace, so it works as a gate and not
only as a report.

See [`DETERMINISM.md`](docs/DETERMINISM.md) for what the reproducibility
guarantee rests on, and what is banned inside the simulation core to keep it.
