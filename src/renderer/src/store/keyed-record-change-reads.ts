import { isIndexKey } from './keyed-record-index-keys'
import {
  linkOf,
  type AddressedKeyChanges,
  type FullResyncReason,
  type Keyed,
  type KeyedSnapshot,
  type Link,
  type RecordChanges,
  type TabMapChanges
} from './keyed-record-transitions'

// Readers that skipped intermediate states still get an exact union; deeper gaps resync.
const MAX_CHAIN = 64

type Walked = AddressedKeyChanges & { tabIds: Set<string> | null }

// Composes forward, oldest write first, so added keys come out in the order the source holds them.
function walk(next: Keyed, previous: Keyed): Walked | FullResyncReason {
  const steps: Exclude<Link, { reason: FullResyncReason }>[] = []
  let current: Keyed = next
  for (let depth = 0; ; depth++) {
    if (depth === MAX_CHAIN) {
      return 'unknown'
    }
    const step = linkOf(current)
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
  const keys = new Set<string>()
  const added = new Set<string>()
  const deleted = new Set<string>()
  let tabIds: Set<string> | null = new Set()
  for (const step of steps.toReversed()) {
    for (const key of step.deleted) {
      if (!added.delete(key)) {
        deleted.add(key)
      }
    }
    for (const key of step.added) {
      // A key the start held, deleted and added back, has moved; only a walk can place it.
      if (deleted.has(key)) {
        return 'reordered'
      }
      added.add(key)
    }
    step.keys.forEach((key) => keys.add(key))
    if (step.tabIds && tabIds) {
      step.tabIds.forEach((id) => tabIds?.add(id))
    } else {
      tabIds = null
    }
  }
  const ordered = steps[0]?.integerKeysFirst
    ? [
        ...[...added].filter(isIndexKey).sort((a, b) => Number(a) - Number(b)),
        ...[...added].filter((key) => !isIndexKey(key))
      ]
    : [...added]
  return { keys, added: ordered, deleted, tabIds }
}

/** null: same identity. Addressed only when every write from `previous` to `next` was annotated. */
export function readRecordChanges(next: Keyed, previous: Keyed): RecordChanges | null {
  if (next === previous) {
    return null
  }
  const result = walk(next, previous)
  return typeof result === 'string'
    ? { kind: 'full-resync', reason: result }
    : { kind: 'addressed', keys: result.keys, added: result.added, deleted: result.deleted }
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
        workspaceSetChanged: result.added.length > 0 || result.deleted.size > 0,
        addedWorkspaceIds: result.added,
        deletedWorkspaceIds: result.deleted
      }
    : { kind: 'full-resync', reason: 'unknown' }
}
