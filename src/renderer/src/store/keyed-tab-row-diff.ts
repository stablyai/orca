import type { Keyed } from './keyed-record-transitions'

type KeyedSnapshot = Readonly<Record<string, unknown>>
type Row = { id: string }
export type TabRowChange<T extends Row> = {
  before: T | undefined
  after: T | undefined
}
export type TabRowChanges<T extends Row> = ReadonlyMap<string, ReadonlyMap<string, TabRowChange<T>>>
const rowsBySnapshot = new WeakMap<Keyed, TabRowChanges<Row> | 'unknown'>()

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

export function tabRowChangesForSnapshot(
  snapshot: Keyed
): TabRowChanges<Row> | 'unknown' | undefined {
  return rowsBySnapshot.get(snapshot)
}
