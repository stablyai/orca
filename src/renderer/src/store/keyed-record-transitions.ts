import { recordTabRowChanges } from './keyed-tab-row-diff'

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

/**
 * Addressed order contract: surviving keys keep their relative order (writers declare a move as
 * `reordered`, a full resync) and `added` lists the keys now present that weren't, in source
 * order. A reader holding its own key ranks places every change exactly in O(changed).
 */
export type AddressedKeyChanges = {
  /** Every added, deleted or replaced key; not ordered. */
  keys: ReadonlySet<string>
  /** In source order: index keys ascending first for records, then insertion order. */
  added: readonly string[]
  deleted: ReadonlySet<string>
}

export type RecordChanges =
  | ({ kind: 'addressed' } & AddressedKeyChanges)
  | { kind: 'full-resync'; reason: FullResyncReason }

export type TabMapChanges =
  | {
      kind: 'addressed'
      workspaceIds: ReadonlySet<string>
      tabIds: ReadonlySet<string>
      /** A workspace key was added or deleted; `addedWorkspaceIds` is in source order. */
      workspaceSetChanged: boolean
      addedWorkspaceIds: readonly string[]
      deletedWorkspaceIds: ReadonlySet<string>
    }
  | { kind: 'full-resync'; reason: FullResyncReason }

/** Any keyed store record a writer replaces: tab buckets or a companion record. */
export type KeyedSnapshot = Readonly<Record<string, unknown>>
/** A Map-typed store field (for example runtime status by environment). */
export type KeyedMapSnapshot = ReadonlyMap<string, unknown>
export type Keyed = KeyedSnapshot | KeyedMapSnapshot
type KeyedRecord<V> = Readonly<Record<string, V>>
type TabRow = { id: string }

export type Link =
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

// An own data property even for `__proto__`, as a computed-key literal or spread would make.
function defineEntry<V>(record: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
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
      defineEntry(next, key, value)
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

/** Ordered set/delete operations on a copy-on-write record; the operations are the provenance. */
export type RecordDraft<V> = {
  has: (key: string) => boolean
  get: (key: string) => V | undefined
  set: (key: string, value: V) => void
  delete: (key: string) => void
  /** The built record linked to `previous`, or `previous` itself when no operation changed it. */
  finish: () => Record<string, V>
}

function createDraft<V>(
  previous: KeyedRecord<V>,
  linkBuilt: (next: Record<string, V>, keys: Set<string>) => void
): RecordDraft<V> {
  let next: Record<string, V> | null = null
  const keys = new Set<string>()
  const removed = new Set<string>()
  let reordered = false
  const current = (): KeyedRecord<V> => next ?? previous
  const writable = (): Record<string, V> => (next ??= { ...previous })
  return {
    has: (key) => Object.hasOwn(current(), key),
    get: (key) => (Object.hasOwn(current(), key) ? current()[key] : undefined),
    set: (key, value) => {
      if (Object.hasOwn(current(), key) && current()[key] === value) {
        return
      }
      reordered ||= removed.has(key)
      defineEntry(writable(), key, value)
      keys.add(key)
    },
    delete: (key) => {
      if (!Object.hasOwn(current(), key)) {
        return
      }
      delete writable()[key]
      removed.add(key)
      keys.add(key)
    },
    finish: () => {
      if (!next) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unchanged; callers publish the same object they read.
        return previous as Record<string, V>
      }
      if (reordered) {
        links.set(next, { reason: 'reordered' })
      } else {
        linkBuilt(next, keys)
      }
      return next
    }
  }
}

/** A draft for a keyed companion record. */
export function recordDraft<V>(previous: KeyedRecord<V>): RecordDraft<V> {
  return createDraft(previous, (next, keys) => link(next, previous, keys))
}

function linkTabBuckets(
  previous: KeyedSnapshot,
  next: KeyedSnapshot,
  keys: Iterable<string>
): void {
  link(next, previous, keys, recordTabRowChanges(previous, next, keys))
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

/** A draft for a tab-bucket map; tab IDs come from diffing only the buckets it replaced. */
export function tabBucketDraft<T extends TabRow>(previous: KeyedRecord<T[]>): RecordDraft<T[]> {
  return createDraft(previous, (next, keys) => linkTabBuckets(previous, next, keys))
}

/** Named cold path: the whole record was rebuilt from a snapshot. */
export function markFullResync<R extends Keyed>(next: R, reason: FullResyncReason): R {
  links.set(next, { reason })
  return next
}

/** Read-only access to a record's provenance link, for the change reader. */
export function linkOf(record: Keyed): Readonly<Link> | undefined {
  return links.get(record)
}
