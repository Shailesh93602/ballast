# Determinism — what the guarantee is, and what it rests on

BALLAST's central claim:

> A run is a pure function of its seed. The same seed produces a byte-identical
> decision log, in the same process, in a fresh process, and on another machine.

Everything else in this repository is quoted against a seed. A bug report that
says _"seed 4711 violates I6"_ is only a bug report if seed 4711 reproduces. So
determinism is not a nice property here — it is the precondition for any other
claim being falsifiable.

## Why this is enforced mechanically rather than by discipline

Nondeterminism does not fail loudly. It produces a run that differs one time in
a thousand, usually on someone else's machine, and it looks exactly like a real
concurrency bug — which is the category of bug this project exists to find. A
simulator that is 99.9% deterministic is worse than useless: it manufactures
phantom findings and burns the time you were trying to save.

So the perimeter is a build error, not a code-review convention.

## The perimeter

Enforced by `no-restricted-syntax` in `eslint.config.mjs`, over
`src/core/**`, `src/policy/**`, `src/oracle/**`, `src/sim/**`:

| Banned                                                           | Why                                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Math.random()`                                                  | Engine-seeded, unreproducible. Thread the `Rng` from `core/rng.ts`.                          |
| `Date.now()`, `new Date()`, `process.hrtime`                     | Wall-clock. Time comes from `Clock`; a decision that reads real time cannot replay.          |
| `setTimeout` / `setInterval` / `setImmediate` / `queueMicrotask` | Real timers reintroduce scheduling the seed does not control. Schedule on the `Clock` queue. |
| `async` / `await` / `new Promise`                                | Interleaving the seed does not control. **The core is synchronous by design.**               |
| `for...in`                                                       | Order is engine-defined for some key shapes.                                                 |
| `Object.keys` / `values` / `entries`                             | Insertion order — silently couples output to _construction_ order. Use `core/order.ts`.      |
| bare `.forEach` on an identifier                                 | Hides the iteration order at the call site. Iterate an explicitly sorted sequence.           |

`src/core/order.ts` is the single sanctioned exception — it is the wrapper the
ban points everyone at.

`src/cli/**` and `test/**` are outside the perimeter on purpose: the CLI does
real file I/O, and the guard itself must spawn processes.

**The rules are tested.** A fixture containing all seven violation classes is
linted and must produce seven errors inside the perimeter and zero outside it. A
ban nobody has watched fire is a ban you do not have.

## The three ways iteration order leaks

Worth stating separately, because it is the failure mode that survives review:

1. **`Object.keys` insertion order.** Integer-like keys come back in ascending
   numeric order; everything else in insertion order. Build the same logical map
   by two code paths and you get two orders.
2. **`Map` / `Set` insertion order.** Same problem, and more tempting, because a
   `Map` _feels_ like an ordered container.
3. **Unstable comparators.** A comparator returning `0` for distinct elements
   leaves their order to the engine's sort. `core/order.ts` never does this —
   `byNumberThen` always takes a string tiebreak so the order is total.

## The event-queue tiebreak

`EventQueue` keys on `(vtime, seq)` where `seq` is a monotonic insertion counter.

The tiebreak is the load-bearing part. Two events at the same tick must be
totally ordered, and if the comparator returns `0` the order falls out of
heap-internal sift behaviour — deterministic in practice, but for reasons nobody
wrote down and nothing tests. Scheduling one extra event anywhere upstream can
change sift paths, so that ambiguity surfaces as an occasional hash mismatch that
looks like a real bug. Including `seq` means **no two events ever compare equal**,
by construction.

Fractional ticks are rejected for the same reason: float comparison would
reintroduce the ambiguity the integer key removes.

## The RNG

xoshiro256\*\*, seeded through SplitMix64, explicitly threaded.

- **Not a module-level singleton.** A shared instance makes a draw depend on how
  many draws happened before it _anywhere in the program_, so two runs differing
  only in evaluation order diverge — and the guard fails for a reason unrelated
  to the thing under test.
- **`fork(label)`** gives a concern its own sub-stream, so adding a fault-injection
  draw does not shift the arrival sequence.
- **Rejection sampling, not modulo.** Modulo bias is invisible in casual testing
  and would skew every weighted choice in the substrate. There is a test that
  asserts four buckets stay within 5% over 40k draws.
- **Not an LCG.** LCGs have poor low-bit entropy, and this simulation makes many
  small decisions (`nextInt(0, 3)`) that read exactly those bits.

## The guard

`test/determinism.test.ts`. Four checks, each catching something different:

1. **1,000 seeds, twice in one process** — catches ambient state carried between
   runs (module-level RNG, caches, counters).
2. **Sampled seeds in a fresh process, against `dist/`** — catches anything
   seeded per-boot, _and_ tests the artifact that actually ships rather than the
   TypeScript source. (This workspace has been bitten before by a test that
   exercised a module the runtime never loaded.)
3. **Different seeds must diverge** — catches a vacuous guard. A simulation that
   ignored its seed entirely would sail through (1) and (2) forever.
4. **The log must be non-empty** — nothing to be identical about otherwise.

Check 3 is the one people leave out, and it is the one that keeps the other two
honest.

## If the guard goes red

Do not skip it and do not add a retry. In order:

1. `git stash` and confirm the failure reproduces on a clean tree.
2. Note whether it fails in-process, cross-process, or both. In-process points at
   carried state; cross-process only points at per-boot ordering.
3. Bisect the seed set — the failing seed is a complete reproduction.
4. Diff the two decision logs and find the first divergent `seq`. The record
   carries `kind`, `tenant`, `runId` and `reason`, so the first difference
   usually names the culprit without a debugger.

**KG0 (day 3):** if the guard is not byte-identical across 1,000 seeds × 3 runs,
spend one day stripping async and unordered iteration out of `core/`. If it is
still red at the end of day 5, abandon the project rather than build on it. A
nondeterministic simulator is precisely the flaky class this project's cost model
forbids.
