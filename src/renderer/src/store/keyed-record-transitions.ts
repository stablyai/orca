// Accepted-write provenance for keyed store records: the writer's helper names what it replaced,
// so readers update only those keys; anything it did not annotate reads as a full resync.

export type FullResyncReason =
  | 'bootstrap'
  | 'hydration'
  | 'host-mirror-frame'
  | 'reconnect-inventory'
  | 'teardown'
  | 'reordered'
  | 'unknown'

export type RecordChanges =
  | { kind: 'addressed'; keys: ReadonlySet<string> }
  | { kind: 'full-resync'; reason: FullResyncReason }

export type TabMapChanges =
  | {
      kind: 'addressed'
      workspaceIds: ReadonlySet<string>
      tabIds: ReadonlySet<string>
      /** A workspace key was added or deleted, so readers that keep source order must re-walk keys. */
      workspaceSetChanged: boolean
    }
  | { kind: 'full-resync'; reason: FullResyncReason }

type Link =
  | {
      previous: WeakRef<KeyedSnapshot>
      keys: ReadonlySet<string>
      tabIds?: ReadonlySet<string>
      keySetChanged?: boolean
    }
  | { reason: FullResyncReason }

/** Any keyed store record a writer replaces: tab buckets or a companion record. */
export type KeyedSnapshot = Readonly<Record<string, unknown>>
type KeyedRecord<V> = Readonly<Record<string, V>>
type TabRow = { id: string }

const links = new WeakMap<KeyedSnapshot, Link>()
// Readers that skipped intermediate states still get an exact union; deeper gaps resync.
const MAX_CHAIN = 64

function link(next: KeyedSnapshot, previous: KeyedSnapshot, keys: ReadonlySet<string>): void {
  links.set(next, { previous: new WeakRef(previous), keys })
}

/** The next record from `previous` plus replacements (null deletes); its changed keys are exact by construction. */
export function replaceRecordEntries<V>(
  previous: KeyedRecord<V>,
  replacements: Iterable<readonly [key: string, value: V | null]>
): Record<string, V> {
  const next: Record<string, V> = { ...previous }
  const keys = new Set<string>()
  for (const [key, value] of replacements) {
    if (value === null) {
      if (Object.hasOwn(next, key)) {
        delete next[key]
        keys.add(key)
      }
    } else if (!Object.hasOwn(next, key) || next[key] !== value) {
      next[key] = value
      keys.add(key)
    }
  }
  link(next, previous, keys)
  return next
}

// Tests prove each builder's named keys cover every entry it changed; production trusts them.
function verifyNamedKeys(
  before: KeyedSnapshot,
  after: KeyedSnapshot,
  keys: ReadonlySet<string>
): void {
  if (import.meta.env.MODE !== 'test') {
    return
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (
      !keys.has(key) &&
      (Object.hasOwn(before, key) !== Object.hasOwn(after, key) || before[key] !== after[key])
    ) {
      throw new Error(`keyed record write changed unnamed key ${key}`)
    }
  }
}

/** For builders that already produced `next`: names the keys it changed (verified under test). */
export function annotateRecordReplacement<R extends KeyedSnapshot>(
  previous: KeyedSnapshot,
  next: R,
  keys: Iterable<string>
): R {
  if (next === previous) {
    return next
  }
  const named = new Set(keys)
  verifyNamedKeys(previous, next, named)
  link(next, previous, named)
  return next
}

function tabRows(record: KeyedSnapshot, key: string): readonly TabRow[] | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined
  return Array.isArray(value) ? value : undefined
}

function changedTabIds(
  previous: readonly TabRow[] | undefined,
  next: readonly TabRow[] | undefined,
  into: Set<string>
): void {
  if (previous === next) {
    return
  }
  const before = new Map((previous ?? []).map((tab) => [tab.id, tab]))
  for (const tab of next ?? []) {
    if (before.get(tab.id) !== tab) {
      into.add(tab.id)
    }
    before.delete(tab.id)
  }
  for (const id of before.keys()) {
    into.add(id)
  }
}

function linkTabBuckets(
  previous: KeyedSnapshot,
  next: KeyedSnapshot,
  keys: ReadonlySet<string>
): void {
  const tabIds = new Set<string>()
  let keySetChanged = false
  for (const workspaceId of keys) {
    keySetChanged ||= Object.hasOwn(previous, workspaceId) !== Object.hasOwn(next, workspaceId)
    changedTabIds(tabRows(previous, workspaceId), tabRows(next, workspaceId), tabIds)
  }
  links.set(next, { previous: new WeakRef(previous), keys, tabIds, keySetChanged })
}

/** Tab-bucket form; tab IDs come from diffing only the replaced buckets. */
export function replaceTabBuckets<T extends TabRow>(
  previous: KeyedRecord<T[]>,
  replacements: Iterable<readonly [workspaceId: string, tabs: T[] | null]>
): Record<string, T[]> {
  const next = replaceRecordEntries(previous, replacements)
  const recorded = links.get(next)
  linkTabBuckets(previous, next, recorded && 'keys' in recorded ? recorded.keys : new Set())
  return next
}

export function annotateTabBucketReplacement<R extends KeyedSnapshot>(
  previous: KeyedSnapshot,
  next: R,
  workspaceIds: Iterable<string>
): R {
  if (next === previous) {
    return next
  }
  const named = new Set(workspaceIds)
  verifyNamedKeys(previous, next, named)
  if (keepsKeyOrder(previous, next)) {
    linkTabBuckets(previous, next, named)
  } else {
    // Bucket order is ownership precedence, so a moved key cannot be expressed as addressed buckets.
    links.set(next, { reason: 'reordered' })
  }
  return next
}

// Addressed tab maps promise surviving keys keep their order and added keys follow them.
function keepsKeyOrder(previous: KeyedSnapshot, next: KeyedSnapshot): boolean {
  const nextKeys = Object.keys(next)
  let index = 0
  for (const key of Object.keys(previous)) {
    if (Object.hasOwn(next, key)) {
      if (nextKeys[index] !== key) {
        return false
      }
      index++
    }
  }
  return nextKeys.slice(index).every((key) => !Object.hasOwn(previous, key))
}

/** Named cold path: the whole record was rebuilt from a snapshot. */
export function markFullResync<R extends KeyedSnapshot>(next: R, reason: FullResyncReason): R {
  links.set(next, { reason })
  return next
}

type Walked = { keys: Set<string>; tabIds: Set<string> | null; keySetChanged: boolean }

function walk(next: KeyedSnapshot, previous: KeyedSnapshot): Walked | FullResyncReason {
  const keys = new Set<string>()
  let tabIds: Set<string> | null = new Set()
  let keySetChanged = false
  let current: KeyedSnapshot = next
  for (let depth = 0; depth < MAX_CHAIN; depth++) {
    const step = links.get(current)
    if (!step) {
      return 'unknown'
    }
    if ('reason' in step) {
      return step.reason
    }
    step.keys.forEach((key) => keys.add(key))
    keySetChanged ||= step.keySetChanged === true
    const stepTabIds = step.tabIds
    if (stepTabIds && tabIds) {
      stepTabIds.forEach((id) => tabIds?.add(id))
    } else {
      tabIds = null
    }
    const before = step.previous.deref()
    if (!before) {
      return 'unknown'
    }
    if (before === previous) {
      return { keys, tabIds, keySetChanged }
    }
    current = before
  }
  return 'unknown'
}

/** null: same identity. Addressed only when every write from `previous` to `next` was annotated. */
export function readRecordChanges(
  next: KeyedSnapshot,
  previous: KeyedSnapshot
): RecordChanges | null {
  if (next === previous) {
    return null
  }
  const result = walk(next, previous)
  return typeof result === 'string'
    ? { kind: 'full-resync', reason: result }
    : { kind: 'addressed', keys: result.keys }
}

export function readTabMapChanges(
  next: KeyedSnapshot,
  previous: KeyedSnapshot
): TabMapChanges | null {
  if (next === previous) {
    return null
  }
  const result = walk(next, previous)
  if (typeof result === 'string') {
    return { kind: 'full-resync', reason: result }
  }
  // A plain record link names no tabs, so it cannot address a tab map.
  return result.tabIds
    ? {
        kind: 'addressed',
        workspaceIds: result.keys,
        tabIds: result.tabIds,
        workspaceSetChanged: result.keySetChanged
      }
    : { kind: 'full-resync', reason: 'unknown' }
}
