# FAIRNESS.md — the noisy-neighbour result

Per-tenant caps exist to stop one abusive tenant degrading everyone else. This is
what that claim is worth, measured.

## Setup

Three tenants against a pool of 6, each capped at 2. One tenant (`abuser`)
submits on every tick; the other two arrive with probability 0.4. Runs hold a
slot for 5 ticks, so capacity genuinely contends — an earlier version of this
harness completed each run on the following tick, which meant nothing ever
competed and **every policy scored a perfect 1.00**. That version measured the
workload, not the policy.

Everything is in **virtual ticks**. No wall-clock latency, no
throughput-per-second: those numbers are machine-dependent and unreproducible,
and would be the first thing anyone asked to see reproduced.

## The metric: degradation, not share

The first metric compared the abuser's admitted count against the median
well-behaved tenant's. That was the wrong question. A tenant that submits ten
times as often and stays under its cap is using **spare** capacity — that is a
pool doing its job, not a noisy neighbour. Measuring share punishes a policy for
being efficient.

The right question is _does the abuser's presence hurt anyone else?_ So each
well-behaved tenant is measured against a **solo baseline** with the abuser
absent and the seed held fixed, so the arrival pattern is identical in both runs.

- **1.00** — the abuser cost the others nothing
- **∞** — a tenant served fine on its own was admitted **zero** times under contention

## Result, over 60 seeds

| Policy                    | Worst degradation | Seeds with total starvation |
| ------------------------- | ----------------- | --------------------------- |
| **Per-tenant caps**       | **1.000**         | 0 / 60                      |
| Global FIFO (control arm) | **∞**             | **38 / 60**                 |

## Why the caps result is 1.000 exactly — and why that is the stronger claim

Because `sum(caps) = 6 ≤ poolCapacity = 6`. The pool is not oversubscribed, so a
slot is reserved for every tenant _by arithmetic_. The abuser cannot take
capacity belonging to someone else, no matter how hard it pushes.

That makes the guarantee **structural, not statistical** — and the distinction
matters when explaining it. A benchmark result invites "what about a harsher
workload?" A structural argument answers it: harsher workloads change how much
the abuser is _rejected_, not how much anyone else is _served_.

The trade-off, stated rather than hidden: reserving capacity per tenant means the
pool can sit idle while a tenant is at its cap. That is the price of isolation,
and it is why the configuration invariant `sum(caps) ≤ poolCapacity` is a
deliberate choice rather than an accident. Relaxing it — oversubscribing on the
assumption tenants will not all peak together — trades this guarantee for
utilisation, and the degradation figure stops being 1.000.

## The control arm exists so the result means something

Global FIFO over the same pool starves a well-behaved tenant **outright in 38 of
60 seeds**. If it ever matched the capped policy, the measurement above would be
describing the workload rather than the policy, and every green run would be
worthless.

This is the same discipline that caught `redlock.test.js` elsewhere in this
workspace encoding the exact bug it should have detected: **a guarantee nothing
can violate is not a guarantee.**

_Generated from `test/fairness.test.ts`. Reproduce with `npm test`._
