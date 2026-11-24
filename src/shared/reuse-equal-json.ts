// Structural sharing for JSON-shaped answers: what an answer repeats keeps the identity it had, so a
// reader comparing by identity re-renders only for what changed.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** `next`, with every part equal to `previous`'s part at the same place replaced by that part; `previous`
 *  itself when the two are equal. Arrays match by index, objects by key. */
export function reuseEqualJson<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) {
    return next
  }
  if (Array.isArray(previous) && Array.isArray(next)) {
    let same = previous.length === next.length
    const merged = next.map((item: unknown, index) => {
      const kept = index < previous.length ? reuseEqualJson(previous[index], item) : item
      same &&= kept === previous[index]
      return kept
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `previous` equals `next` part for part, so it is a T.
    return (same ? previous : merged) as T
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const keys = Object.keys(next)
    let same = keys.length === Object.keys(previous).length
    const merged: Record<string, unknown> = {}
    for (const key of keys) {
      const kept = Object.hasOwn(previous, key)
        ? reuseEqualJson(previous[key], next[key])
        : next[key]
      same &&= Object.hasOwn(previous, key) && kept === previous[key]
      merged[key] = kept
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `merged` holds `next`'s keys with equal values, so it is a T; so is an equal `previous`.
    return (same ? previous : merged) as T
  }
  return next
}
