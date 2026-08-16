/**
 * Deterministic iteration.
 *
 * The subtlest way a simulation stops being reproducible is iteration order.
 * `Object.keys` returns integer-like keys in ascending numeric order and the
 * rest in *insertion* order, so output silently depends on the order objects
 * were built — which can differ between a fresh run and a resumed one, or
 * between engine versions. `Map`/`Set` iterate in insertion order for the same
 * reason. None of that is visible at the call site, and none of it fails
 * loudly; it just makes one run in a thousand differ.
 *
 * So the whole determinism perimeter bans those calls (see eslint.config.mjs)
 * and points here. This is the one module allowed to use them.
 */

/** Object keys in ascending lexicographic order. */
export function sortedKeys<T extends object>(obj: T): string[] {
  return Object.keys(obj).sort();
}

/** Object entries in ascending key order. */
export function sortedEntries<V>(obj: Record<string, V>): Array<[string, V]> {
  return Object.keys(obj)
    .sort()
    .map((k) => [k, obj[k] as V]);
}

/** Map entries in ascending key order. Keys must be strings — see `byKey`. */
export function sortedMapEntries<V>(map: ReadonlyMap<string, V>): Array<[string, V]> {
  return [...map.keys()].sort().map((k) => [k, map.get(k) as V]);
}

/** Map keys in ascending order. */
export function sortedMapKeys<V>(map: ReadonlyMap<string, V>): string[] {
  return [...map.keys()].sort();
}

/** Set members in ascending order. */
export function sortedSet(set: ReadonlySet<string>): string[] {
  return [...set].sort();
}

/**
 * Sort a copy by a string key. Never sorts in place — an in-place sort of a
 * caller's array is itself a source of order-dependent behaviour.
 */
export function byKey<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Sort a copy by a numeric key, with a string tiebreak so the result is a total
 * order. A comparator that returns 0 for distinct elements leaves their relative
 * order to the engine's sort stability, which is exactly the ambiguity we are
 * trying to remove.
 */
export function byNumberThen<T>(
  items: readonly T[],
  num: (item: T) => number,
  tiebreak: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => {
    const d = num(a) - num(b);
    if (d !== 0) return d;
    const ta = tiebreak(a);
    const tb = tiebreak(b);
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
}
