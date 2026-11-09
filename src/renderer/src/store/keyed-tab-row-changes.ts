import { linkOf, type Keyed, type KeyedSnapshot } from './keyed-record-transitions'

type Row = { id: string }
export type TabRowChange<T extends Row> = {
  before: T | undefined
  after: T | undefined
}
type Changes<T extends Row> = ReadonlyMap<string, ReadonlyMap<string, TabRowChange<T>>>
const rowsBySnapshot = new WeakMap<Keyed, Changes<Row> | 'unknown'>()

function rows(record: KeyedSnapshot, key: string): readonly Row[] | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined
  return Array.isArray(value) ? value : undefined
}

export function recordTabRowChanges(
  previous: KeyedSnapshot,
  next: KeyedSnapshot,
  keys: Iterable<string>
): Set<string> {
  const tabIds = new Set<string>()
  const changed = new Map<string, Map<string, TabRowChange<Row>>>()
  let reordered = false
  for (const workspaceId of keys) {
    const previousRows = rows(previous, workspaceId)
    const nextRows = rows(next, workspaceId)
    if (previousRows === nextRows) {
      continue
    }
    const before = new Map((previousRows ?? []).map((tab, index) => [tab.id, index]))
    const changes = new Map<string, TabRowChange<Row>>()
    let lastPosition = -1
    for (const tab of nextRows ?? []) {
      const position = before.get(tab.id)
      const previousTab = position === undefined ? undefined : previousRows?.[position]
      if (position !== undefined) {
        reordered ||= position < lastPosition
        lastPosition = position
      }
      if (previousTab !== tab) {
        tabIds.add(tab.id)
        changes.set(tab.id, { before: previousTab, after: tab })
      }
      before.delete(tab.id)
    }
    for (const [id, position] of before) {
      tabIds.add(id)
      changes.set(id, { before: previousRows?.[position], after: undefined })
    }
    changed.set(workspaceId, changes)
  }
  // Changed rows cannot describe which duplicate entity wins after a reorder.
  rowsBySnapshot.set(next, reordered ? 'unknown' : changed)
  return tabIds
}

/** Only changed row references survive the writer's existing diff; unavailable histories resync. */
export function readTabRowChanges<T extends Row>(
  next: Readonly<Record<string, readonly T[]>>,
  previous: Readonly<Record<string, readonly T[]>>
): Changes<T> | 'unknown' | null {
  if (next === previous) {
    return null
  }
  const steps: Changes<Row>[] = []
  let current: Keyed = next
  for (let depth = 0; ; depth++) {
    const link = linkOf(current)
    const changes = rowsBySnapshot.get(current)
    if (depth === 64 || !link || 'reason' in link || !changes || changes === 'unknown') {
      return 'unknown'
    }
    steps.push(changes)
    const before = link.previous.deref()
    if (!before) {
      return 'unknown'
    }
    if (before === previous) {
      break
    }
    current = before
  }
  const composed = new Map<string, Map<string, TabRowChange<T>>>()
  for (const step of steps.toReversed()) {
    for (const [workspaceId, changes] of step) {
      let bucket = composed.get(workspaceId)
      if (!bucket) {
        composed.set(workspaceId, (bucket = new Map()))
      }
      for (const [tabId, untypedChange] of changes) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the net endpoints belong to the supplied T snapshots.
        const change = untypedChange as TabRowChange<T>
        const earlier = bucket.get(tabId)
        bucket.set(tabId, { before: earlier ? earlier.before : change.before, after: change.after })
      }
    }
  }
  return composed
}
