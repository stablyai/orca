// Structural sharing for JSON-shaped answers: what an answer repeats keeps the identity it had, so a
// reader comparing by identity re-renders only for what changed.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function uidOf(value: unknown): string | null {
  return isPlainObject(value) && typeof value.uid === 'string' ? value.uid : null
}

/** A list of records that each carry a `uid` (items) pairs by it, so a reordered record keeps its identity. */
function previousByUid(previous: readonly unknown[], next: readonly unknown[]): Map<string, unknown> | null {
  if (previous.length === 0 || !next.every((item) => uidOf(item) !== null)) {
    return null
  }
  const byUid = new Map<string, unknown>()
  for (const item of previous) {
    const uid = uidOf(item)
    if (uid === null) {
      return null
    }
    byUid.set(uid, item)
  }
  return byUid
}

/** `next`, with every part equal to `previous`'s part at the same place replaced by that part; `previous`
 *  itself when the two are equal. Arrays match by index, or by `uid` when every element has one; objects
 *  by key. */
export function reuseEqualJson<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) {
    return next
  }
  if (Array.isArray(previous) && Array.isArray(next)) {
    let same = previous.length === next.length
    const byUid = previousByUid(previous, next)
    const merged = next.map((item: unknown, index) => {
      const match = byUid
        ? byUid.get(uidOf(item)!)
        : index < previous.length
          ? previous[index]
          : undefined
      const kept = match === undefined ? item : reuseEqualJson(match, item)
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
