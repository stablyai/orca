// Structural sharing for JSON-shaped answers: what an answer repeats keeps the identity it had, so a
// reader comparing by identity re-renders only for what changed.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** A record's `uid`: one property read, so pairing costs nothing next to the comparison it picks. */
function uidOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('uid' in value)) {
    return null
  }
  return typeof value.uid === 'string' ? value.uid : null
}

/** How far from its place a moved record is looked for before every previous record is indexed. */
const NEARBY = 8

function nearbyByUid(previous: readonly unknown[], index: number, uid: string): unknown {
  for (let distance = 1; distance <= NEARBY; distance++) {
    if (uidOf(previous[index - distance]) === uid) {
      return previous[index - distance]
    }
    if (uidOf(previous[index + distance]) === uid) {
      return previous[index + distance]
    }
  }
  return undefined
}

/** Previous records by `uid`, built only once a record has moved; null when some previous one has none. */
function indexByUid(previous: readonly unknown[]): Map<string, unknown> | null {
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
 *  itself when the two are equal. Arrays match by index, except that a record whose `uid` moved pairs
 *  with the previous record carrying it; objects match by key. */
export function reuseEqualJson<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) {
    return next
  }
  if (Array.isArray(previous) && Array.isArray(next)) {
    let same = previous.length === next.length
    let byUid: Map<string, unknown> | null | undefined
    // Only a list of records led by one with a `uid` (items) pairs by it; any other array pays one check.
    const keyed = uidOf(next[0]) !== null
    // Records pair by place until one is found whose `uid` moved; from there each pairs with the previous
    // record carrying its `uid`, so it keeps its identity and is compared once, with itself. An answer in
    // the same order reads no `uid` past the records that changed.
    let moved = false
    const pairByUid = (item: unknown, index: number, uid: string): unknown => {
      // A record moved a few places (others added, removed or swapped near it) is found close by; past
      // that, every previous record is indexed once.
      const near = byUid === undefined ? nearbyByUid(previous, index, uid) : undefined
      if (near !== undefined) {
        return near
      }
      byUid = byUid === undefined ? indexByUid(previous) : byUid
      return byUid ? byUid.get(uid) : previous[index]
    }
    const merged = next.map((item: unknown, index) => {
      const atIndex = index < previous.length ? previous[index] : undefined
      let kept: unknown
      if (moved) {
        const uid = uidOf(item)
        const match = uid === null || uidOf(atIndex) === uid ? atIndex : pairByUid(item, index, uid)
        kept = match === undefined ? item : reuseEqualJson(match, item)
      } else {
        // Past the previous end, in the same order, a record is new.
        kept = atIndex === undefined ? item : reuseEqualJson(atIndex, item)
        const uid = keyed && kept !== atIndex && atIndex !== undefined ? uidOf(item) : null
        if (uid !== null && uidOf(atIndex) !== uid) {
          moved = true
          const match = pairByUid(item, index, uid)
          kept = match === undefined ? item : reuseEqualJson(match, item)
        }
      }
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
