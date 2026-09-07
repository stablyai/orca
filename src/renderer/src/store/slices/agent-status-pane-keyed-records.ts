export const RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX = 1024
export const RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX = 1024

// delete-then-set for LRU recency, then evict oldest keys past the cap (Record iterates
// insertion order); safe because a status for a tab closed >MAX tabs ago cannot still arrive.
function boundLruKeyRecord(
  existing: Record<string, true>,
  additions: ReadonlySet<string>,
  max: number
): Record<string, true> {
  if (isLruKeyRecordUnchanged(existing, additions, max)) {
    return existing
  }
  const next: Record<string, true> = {}
  for (const key of Object.keys(existing)) {
    if (!additions.has(key)) {
      next[key] = true
    }
  }
  for (const key of additions) {
    next[key] = true
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
function isLruKeyRecordUnchanged(
  existing: Record<string, true>,
  additions: ReadonlySet<string>,
  max: number
): boolean {
  const keys = Object.keys(existing)
  if (keys.length > max || additions.size > keys.length) {
    return false
  }
  let index = keys.length - additions.size
  for (const key of additions) {
    if (keys[index++] !== key) {
      return false
    }
  }
  return true
}

export function boundRecentlyClosedAgentStatusTabIds(
  existing: Record<string, true>,
  tabId: string
): Record<string, true> {
  return boundLruKeyRecord(existing, new Set([tabId]), RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX)
}

export function boundRecentlyRetiredAgentStatusPaneKeys(
  existing: Record<string, true>,
  paneKeys: readonly string[]
): Record<string, true> {
  return boundLruKeyRecord(existing, new Set(paneKeys), RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX)
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
  const matchingKeys = Object.keys(record).filter((key) => paneKeys.has(key))
  if (matchingKeys.length === 0) {
    return record
  }
  const next = { ...record }
  for (const key of matchingKeys) {
    delete next[key]
  }
  return next
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
