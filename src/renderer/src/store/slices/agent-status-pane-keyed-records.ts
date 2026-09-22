export const RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX = 1024
export const RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX = 1024

// delete-then-set for LRU recency, then evict oldest keys past the cap (Record iterates
// insertion order); safe because a status for a tab closed >MAX tabs ago cannot still arrive.
function boundLruKeyRecord<Value extends true | string>(
  existing: Record<string, Value>,
  additions: ReadonlySet<string>,
  max: number,
  value: Value
): Record<string, Value> {
  if (isLruKeyRecordUnchanged(existing, additions, max, value)) {
    return existing
  }
  const next: Record<string, Value> = {}
  for (const key of Object.keys(existing)) {
    if (!additions.has(key)) {
      next[key] = existing[key]
    }
  }
  for (const key of additions) {
    next[key] = value
  }
  const keys = Object.keys(next)
  for (const stale of keys.slice(0, -max)) {
    delete next[stale]
  }
  return next
}

// The rebuild is a no-op only when nothing would be evicted and the additions are
// already the tail of `existing` in that same relative order. A matching key SET is
// not enough: re-adding a key moves it to the tail, and that order decides which key
// the cap evicts next, so a stale-order hit would un-fence a recently retired pane.
function isLruKeyRecordUnchanged<Value extends true | string>(
  existing: Record<string, Value>,
  additions: ReadonlySet<string>,
  max: number,
  value: Value
): boolean {
  const keys = Object.keys(existing)
  if (keys.length > max || additions.size > keys.length) {
    return false
  }
  let index = keys.length - additions.size
  for (const key of additions) {
    if (keys[index++] !== key || existing[key] !== value) {
      return false
    }
  }
  return true
}

export function boundRecentlyClosedAgentStatusTabIds(
  existing: Record<string, true>,
  tabId: string
): Record<string, true> {
  return boundLruKeyRecord(
    existing,
    new Set([tabId]),
    RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX,
    true
  )
}

export function boundRecentlyRetiredAgentStatusPaneKeys(
  existing: Record<string, true | string>,
  paneKeys: readonly string[],
  retirementId: true | string = true
): Record<string, true | string> {
  return boundLruKeyRecord(
    existing,
    new Set(paneKeys),
    RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX,
    retirementId
  )
}

export function movePaneKeyedRecord<T>(
  record: Record<string, T>,
  fromPaneKey: string,
  toPaneKey: string,
  transform: (value: T) => T = (value) => value
): Record<string, T> {
  const value = record[fromPaneKey]
  if (value === undefined || fromPaneKey === toPaneKey) {
    return record
  }
  const next = { ...record }
  delete next[fromPaneKey]
  next[toPaneKey] = transform(value)
  return next
}

export function removePaneKeys<T>(
  record: Record<string, T>,
  paneKeys: ReadonlySet<string>
): Record<string, T> {
  // Probe the requested keys instead of enumerating the record, and copy only once a key
  // actually matches: pane retirement calls this across a dozen records that usually hold
  // none of the retired keys, so the no-op path must stay allocation-free and keep returning
  // the same reference. `propertyIsEnumerable` is own-only, so inherited keys such as
  // `toString` or `__proto__` are never deletable.
  let next: Record<string, T> | null = null
  for (const key of paneKeys) {
    if (!Object.prototype.propertyIsEnumerable.call(record, key)) {
      continue
    }
    next ??= { ...record }
    delete next[key]
  }
  return next ?? record
}

export function removePaneKeysByTabPrefix<T>(
  record: Record<string, T>,
  tabPrefix: string,
  extraPaneKeys: ReadonlySet<string> = new Set()
): Record<string, T> {
  const prefix = `${tabPrefix}:`
  const matchingKeys = Object.keys(record).filter(
    (key) => key.startsWith(prefix) || extraPaneKeys.has(key)
  )
  return removePaneKeys(record, new Set(matchingKeys))
}

/** A closed physical key revokes recovery for its whole retired alias group. */
export function closedAgentStatusRetirementKeys(
  existing: Record<string, true | string>,
  prefix: string,
  aliasPaneKeys: readonly string[]
): string[] {
  const keys = new Set(aliasPaneKeys)
  const ids = new Set<string>()
  for (const [key, value] of Object.entries(existing)) {
    if (key.startsWith(prefix) || keys.has(key)) {
      keys.add(key)
      if (typeof value === 'string') {
        ids.add(value)
      }
    }
  }
  for (const [key, value] of Object.entries(existing)) {
    if (typeof value === 'string' && ids.has(value)) {
      keys.add(key)
    }
  }
  return [...keys]
}
