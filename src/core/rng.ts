/**
 * xoshiro256** — a seeded PRNG, explicitly threaded.
 *
 * WHY NOT `Math.random()`: it is seeded by the engine and cannot be reproduced,
 * which would make every claim in this repo unfalsifiable.
 *
 * WHY NOT A MODULE-LEVEL INSTANCE: a shared singleton makes a call's result
 * depend on how many calls happened *before* it anywhere in the program. Two
 * runs that differ only in evaluation order would then diverge, and the
 * determinism guard would fail for a reason unrelated to the thing under test.
 * So an `Rng` is a value that is passed down explicitly, and a sub-stream can be
 * forked for an independent concern (see `fork`).
 *
 * xoshiro256** is chosen over a linear congruential generator because LCGs have
 * notoriously poor low-bit entropy, and this simulation makes many small
 * decisions (`nextInt(0, 3)`) that read exactly those bits.
 */

const MASK64 = (1n << 64n) - 1n;

function rotl(x: bigint, k: bigint): bigint {
  return ((x << k) | (x >> (64n - k))) & MASK64;
}

/**
 * SplitMix64 — used only to expand a single 32-bit-ish seed into the four
 * 64-bit words xoshiro needs. Seeding a xoshiro state with mostly-zero words
 * produces a poor initial stream; SplitMix64 is the author's recommended fix.
 */
function splitmix64(state: bigint): { value: bigint; next: bigint } {
  const z = (state + 0x9e3779b97f4a7c15n) & MASK64;
  let x = z;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  x = x ^ (x >> 31n);
  return { value: x & MASK64, next: z };
}

export class Rng {
  private s0: bigint;
  private s1: bigint;
  private s2: bigint;
  private s3: bigint;

  constructor(seed: number | bigint) {
    let sm = BigInt(seed) & MASK64;
    const a = splitmix64(sm);
    sm = a.next;
    const b = splitmix64(sm);
    sm = b.next;
    const c = splitmix64(sm);
    sm = c.next;
    const d = splitmix64(sm);
    this.s0 = a.value;
    this.s1 = b.value;
    this.s2 = c.value;
    this.s3 = d.value;
  }

  /** Raw 64-bit draw. */
  private next64(): bigint {
    const result = (rotl((this.s1 * 5n) & MASK64, 7n) * 9n) & MASK64;
    const t = (this.s1 << 17n) & MASK64;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 45n);
    return result;
  }

  /** Uniform float in [0, 1). 53 bits of mantissa, the most a double carries. */
  nextFloat(): number {
    return Number(this.next64() >> 11n) / 2 ** 53;
  }

  /**
   * Uniform integer in [minInclusive, maxExclusive).
   *
   * Uses rejection sampling rather than modulo. Modulo bias is invisible in
   * casual testing and would quietly skew every weighted fault choice in the
   * substrate — precisely the kind of bug this project exists to catch.
   */
  nextInt(minInclusive: number, maxExclusive: number): number {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
      throw new Error("nextInt requires integer bounds");
    }
    if (maxExclusive <= minInclusive) {
      throw new Error(`nextInt: empty range [${minInclusive}, ${maxExclusive})`);
    }
    const range = BigInt(maxExclusive - minInclusive);
    // Largest multiple of `range` that fits in 64 bits; draws at or above it are
    // rejected so every residue is equally likely.
    const limit = (MASK64 / range) * range;
    let draw = this.next64();
    while (draw >= limit) draw = this.next64();
    return minInclusive + Number(draw % range);
  }

  /** True with probability `p`. */
  nextBool(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.nextFloat() < p;
  }

  /**
   * Pick an index by weight. Weights need not sum to 1.
   * Returns -1 only if every weight is zero.
   */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) {
      if (w < 0) throw new Error("weightedIndex: negative weight");
      total += w;
    }
    if (total === 0) return -1;
    let target = this.nextFloat() * total;
    for (let i = 0; i < weights.length; i++) {
      target -= weights[i] ?? 0;
      if (target < 0) return i;
    }
    return weights.length - 1;
  }

  /**
   * An independent sub-stream, labelled.
   *
   * Lets one concern (say, fault injection) draw without shifting another's
   * sequence. The label is hashed in, so `fork("faults")` and `fork("arrivals")`
   * diverge immediately rather than producing correlated streams.
   */
  fork(label: string): Rng {
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < label.length; i++) {
      h ^= BigInt(label.charCodeAt(i));
      h = (h * 0x100000001b3n) & MASK64;
    }
    return new Rng((this.next64() ^ h) & MASK64);
  }
}
