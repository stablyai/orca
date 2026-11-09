import { isIndexKey, keepsKeyOrder, verifyNamedKeys } from './keyed-record-key-checks'

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

/** Any keyed store record a writer replaces: tab buckets or a companion record. */
export type KeyedSnapshot = Readonly<Record<string, unknown>>
/** A Map-typed store field (for example runtime status by environment). */
export type KeyedMapSnapshot = ReadonlyMap<string, unknown>
type Keyed = KeyedSnapshot | KeyedMapSnapshot
type KeyedRecord<V> = Readonly<Record<string, V>>
type TabRow = { id: string }

type Link =
  | {
      previous: WeakRef<Keyed>
      /** Changed keys in write order. */
      keys: readonly string[]
      added: readonly string[]
      deleted: readonly string[]
      /** Records list integer-like keys first, ascending, as Object.keys does; Maps keep insertion order. */
      integerKeysFirst: boolean
      tabIds?: ReadonlySet<string>
    }
  | { reason: FullResyncReason }

const links = new WeakMap<Keyed, Link>()
// Readers that skipped intermediate states still get an exact union; deeper gaps resync.
const MAX_CHAIN = 64

function hasKey(record: Keyed, key: string): boolean {
  return record instanceof Map ? record.has(key) : Object.hasOwn(record, key)
}

function link(next: Keyed, previous: Keyed, keys: Iterable<string>, tabIds?: Set<string>): void {
  const ordered = [...keys]
  links.set(next, {
    previous: new WeakRef(previous),
    keys: ordered,
    added: ordered.filter((key) => !hasKey(previous, key) && hasKey(next, key)),
    deleted: ordered.filter((key) => hasKey(previous, key) && !hasKey(next, key)),
    integerKeysFirst: !(next instanceof Map),
    ...(tabIds ? { tabIds } : {})
  })
}

type Replacement<V> = readonly [key: string, value: V | null]

// Deleting then re-adding a surviving key moves it to the end, which an addressed key set can't express.
function replaceEntries<V>(
  has: (key: string) => boolean,
  get: (key: string) => V | undefined,
  set: (key: string, value: V) => void,
  remove: (key: string) => void,
  replacements: Iterable<Replacement<V>>
): { keys: Set<string>; reordered: boolean } {
  const keys = new Set<string>()
  const removed = new Set<string>()
  let reordered = false
  for (const [key, value] of replacements) {
    if (value === null) {
      if (has(key)) {
        remove(key)
        removed.add(key)
        keys.add(key)
      }
    } else if (!has(key) || get(key) !== value) {
      reordered ||= removed.has(key)
      set(key, value)
      keys.add(key)
    }
  }
  return { keys, reordered }
}

/** The next record from `previous` plus replacements (null deletes); its changed keys are exact by construction. */
export function replaceRecordEntries<V>(
  previous: KeyedRecord<V>,
  replacements: Iterable<Replacement<V>>
): Record<string, V> {
  const next: Record<string, V> = { ...previous }
  const { keys, reordered } = replaceEntries<V>(
    (key) => Object.hasOwn(next, key),
    (key) => next[key],
    (key, value) => {
      next[key] = value
    },
    (key) => {
      delete next[key]
    },
    replacements
  )
  if (reordered) {
    links.set(next, { reason: 'reordered' })
  } else {
    link(next, previous, keys)
  }
  return next
}

/** Map form of replaceRecordEntries, read with the same readRecordChanges protocol. */
export function replaceMapEntries<V>(
  previous: ReadonlyMap<string, V>,
  replacements: Iterable<Replacement<V>>
): Map<string, V> {
  const next = new Map(previous)
  const { keys, reordered } = replaceEntries<V>(
    (key) => next.has(key),
    (key) => next.get(key),
    (key, value) => next.set(key, value),
    (key) => next.delete(key),
    replacements
  )
  if (reordered) {
    links.set(next, { reason: 'reordered' })
  } else {
    link(next, previous, keys)
  }
  return next
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
  if (keepsKeyOrder(previous, next)) {
    link(next, previous, named)
  } else {
    links.set(next, { reason: 'reordered' })
  }
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
  keys: Iterable<string>
): void {
  const tabIds = new Set<string>()
  for (const workspaceId of keys) {
    changedTabIds(tabRows(previous, workspaceId), tabRows(next, workspaceId), tabIds)
  }
  link(next, previous, keys, tabIds)
}

/** Tab-bucket form; tab IDs come from diffing only the replaced buckets. */
export function replaceTabBuckets<T extends TabRow>(
  previous: KeyedRecord<T[]>,
  replacements: Iterable<readonly [workspaceId: string, tabs: T[] | null]>
): Record<string, T[]> {
  const next = replaceRecordEntries(previous, replacements)
  const recorded = links.get(next)
  if (recorded && 'keys' in recorded) {
    linkTabBuckets(previous, next, recorded.keys)
  }
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
    // Key order is ownership precedence, so a moved key cannot be expressed as addressed keys.
    links.set(next, { reason: 'reordered' })
  }
  return next
}

/** Named cold path: the whole record was rebuilt from a snapshot. */
export function markFullResync<R extends Keyed>(next: R, reason: FullResyncReason): R {
  links.set(next, { reason })
  return next
}

type Walked = {
  keys: Set<string>
  tabIds: Set<string> | null
  keySetChanged: boolean
}

// Composes forward, oldest write first, so added keys come out in the order the source holds them.
function walk(next: Keyed, previous: Keyed): Walked | FullResyncReason {
  const steps: Exclude<Link, { reason: FullResyncReason }>[] = []
  let current: Keyed = next
  for (let depth = 0; ; depth++) {
    if (depth === MAX_CHAIN) {
      return 'unknown'
    }
    const step = links.get(current)
    if (!step) {
      return 'unknown'
    }
    if ('reason' in step) {
      return step.reason
    }
    steps.push(step)
    const before = step.previous.deref()
    if (!before) {
      return 'unknown'
    }
    if (before === previous) {
      break
    }
    current = before
  }
  const touched = new Set<string>()
  const deleted = new Set<string>()
  let tabIds: Set<string> | null = new Set()
  let keySetChanged = false
  for (const step of steps.toReversed()) {
    for (const key of step.added) {
      // A key deleted earlier in the chain and added back has moved; only a walk can place it.
      if (deleted.has(key)) {
        return 'reordered'
      }
    }
    step.deleted.forEach((key) => deleted.add(key))
    step.keys.forEach((key) => touched.add(key))
    keySetChanged ||= step.added.length > 0 || step.deleted.length > 0
    if (step.tabIds && tabIds) {
      step.tabIds.forEach((id) => tabIds?.add(id))
    } else {
      tabIds = null
    }
  }
  const ordered = steps[0]?.integerKeysFirst
    ? [
        ...[...touched].filter(isIndexKey).sort((a, b) => Number(a) - Number(b)),
        ...[...touched].filter((key) => !isIndexKey(key))
      ]
    : [...touched]
  return { keys: new Set(ordered), tabIds, keySetChanged }
}

/** null: same identity. Addressed only when every write from `previous` to `next` was annotated. */
/** Changed keys come in source order: chronological additions, with integer keys first for records. */
export function readRecordChanges(next: Keyed, previous: Keyed): RecordChanges | null {
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
