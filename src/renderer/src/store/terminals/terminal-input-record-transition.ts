type RecordTransition = { previous: WeakRef<object>; keys: ReadonlySet<string> }
const transitions = new WeakMap<object, RecordTransition>()

/** Exact writer provenance is transient; weak previous identities cannot retain a history of store snapshots. */
export function terminalInputRecordTransition<T extends object>(
  previous: T,
  next: T,
  keys: Iterable<string>
): T {
  if (next !== previous) {
    transitions.set(next, { previous: new WeakRef(previous), keys: new Set(keys) })
  }
  return next
}

export function terminalInputRecordChangedKeys(
  previous: object,
  next: object
): ReadonlySet<string> | null {
  if (previous === next) {
    return new Set()
  }
  const keys = new Set<string>()
  const visited = new Set<object>()
  let cursor: object | undefined = next
  while (cursor !== previous && cursor !== undefined && !visited.has(cursor)) {
    visited.add(cursor)
    const transition = transitions.get(cursor)
    if (!transition) {
      return null
    }
    for (const key of transition.keys) {
      keys.add(key)
    }
    cursor = transition.previous.deref()
  }
  return cursor === previous ? keys : null
}
