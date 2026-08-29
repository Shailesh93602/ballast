# BALLAST

A deterministic simulation of a **multi-tenant session control plane** — per-tenant
parallel caps, a rolling credit window, a finite warm pool, leases over a
substrate that lies, and an at-least-once completion channel built as a replay
log with opaque replay IDs and subscriber-driven credit flow control.

One integer seed in. One byte-identical decision log out.

**Zero runtime dependencies.** `git clone && npm install && npm test`.

---

## What it found

A test suite is worth what it caught, not what it asserts. These are real bugs,
found by the harness, that nobody planted. Planted mutants live in
[`MUTATION.md`](docs/MUTATION.md) and are deliberately kept out of this list.

| #      | Found by                    | What                                                                                                                                                                                                |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L2** | Differential oracle, seed 1 | **A spec gap.** Nothing said whether completing a run releases its slot. The implementation held it until lease expiry; the reference freed it. Neither was wrong — the spec was silent.            |
| **L1** | Invariant corpus            | **The checker trusted the thing it was checking.** I5 fired on stale releases that were _correctly refused_, because it read the plane's self-assessment instead of raw facts.                      |
| **L3** | Differential, seed 101      | **The reference billed credit that was never spent** — it asked whether a run appeared in the status map, but `cancel` inserts a runId even for a _rejected_ admit.                                 |
| **L6** | Mechanical mutation         | **Every duplicate completion answered `replayId: 0`** — the lookup ran through a helper that unconditionally returned `undefined`, while the endpoint answered `ok: true`.                          |
| **L4** | Mechanical mutation         | **An unreachable branch pretending to be a guard.** `slot.released` was assigned `false` in four places and `true` in none.                                                                         |
| **L5** | Mechanical mutation         | Dead state: `slot.runId` written five times, read never.                                                                                                                                            |
| **L7** | Mutation run on a red suite | **The harness reported 100% because the suite already failed.** A mutant is killed when the suite fails — so if it fails first, every mutant is killed. The reassuring number was the alarming one. |
| **L8** | Testing a surviving mutant  | **A retry-limit branch that could never run**, because contention in the model stopped after attempt 1. The fix corrected the model, not the branch — a busy row stays busy.                        |

Full write-ups: [`LEDGER.md`](docs/LEDGER.md).

Three of the eight were in the **checker or the harness**, not the system under test. That ratio is
the most useful thing this project taught: every layer that grades another needs someone grading it,
and eventually that someone is you asking what the output would look like if the tool were wrong.

**L2 is the one worth reading.** The two engines were built from the same
specification but not the same assumption, so they **disagreed instead of being
confidently wrong together**. Had one author written both in one sitting they
would have matched, the differential would have been green, and finished runs
would have silently occupied pool slots until their leases aged out.

That is the entire argument for [`SEMANTICS.md`](docs/SEMANTICS.md) existing —
and being committed — before a line of policy code.

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

**I8 is blind to a wrong identity.** It counts effects per identity, so keying a
dedup on the wrong field produces two rows each with a legitimate count of one.
Recorded as a test in `khatago.test.ts` rather than omitted.

**The KhataGO verification is of the PROTOCOL, not the implementation.** It shows
the mechanism is sound. It does not show that KhataGO's Prisma calls implement
the mechanism faithfully — that needs the real handler driven against a real
database, which is Tier B and has not run yet.

**The claim protocol has no reaper.** A claimant that dies leaves its row stuck in
`PROCESSING` forever. Asserted as a test so it cannot quietly stop being true.

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

## Numbers

Every figure below is produced by a test in this repository. A CI job greps this
file for each one and fails if the run does not reproduce it.

- **1,000 seeds** byte-identical, in-process and across a fresh process, against
  the built artifact
- **182 tests**
- **87.3% mutation score** over `src/policy` (144 of 165 mechanical mutants killed)
- **16 of 16** semantic mutants caught
- **2,000 invariant histories**, checked after _every_ event
- **300 differential histories**
- **500 KhataGO protocol runs** under the fault injector
- Fairness: per-tenant caps **1.000×** degradation; global FIFO starves a
  well-behaved tenant outright in **38 of 60** seeds

---

## Layout

```
src/core/      seeded PRNG, virtual clock, event queue, decision log, ordering
src/sim/       the substrate that lies
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
