// The Loader's one report: a field-by-field diff of the stored session against what the next save
// writes, over the records the disk-field tables name.

import type { WorkspaceSessionState } from '../workspace-session-state-types'
import type { DiskTable } from './workspace-layout-disk-fields'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { paneKeyOf } from './workspace-layout-model'

export type LayoutLoadChange = {
  /** A disk-field table name (workspace-layout-disk-fields.ts). */
  table: string
  /** Workspace key and record id, or the record's own map key. */
  record: string
  /** `*` when the whole record is added or dropped; `$order` for a list's order. */
  field: string
  before: unknown
  after: unknown
}

type DiskRecord = Record<string, unknown>
export type DiskRecords = Record<DiskTable, Map<string, DiskRecord>>

// Why absent reads as empty: the Serializer always writes these maps, so a missing one is no change.
function sortedKeys(map: Record<string, unknown> | undefined): string[] {
  return Object.keys(map ?? {}).sort()
}

/** Every record on disk, by the table its fields are listed in. */
export function diskRecords(session: WorkspaceSessionState): DiskRecords {
  const table = () => new Map<string, DiskRecord>()
  const records: DiskRecords = {
    row: table(),
    terminalEntry: table(),
    entry: table(),
    group: table(),
    layout: table(),
    file: table(),
    browser: table(),
    sleeping: table(),
    incarnation: table(),
    closedTab: table(),
    session: table()
  }
  const listOrder = (table: DiskTable, key: string, ids: string[]) =>
    records[table].set(`${key}|$order`, { $order: ids })
  const rowIds = new Set<string>()
  const worktreeIds = new Set<string>()
  for (const [key, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    listOrder(
      'row',
      key,
      rows.map((row) => row.id)
    )
    for (const row of rows) {
      rowIds.add(row.id)
      worktreeIds.add(row.worktreeId)
      records.row.set(`${key}|${row.id}`, row)
    }
  }
  for (const [key, entries] of Object.entries(session.unifiedTabs ?? {})) {
    listOrder(
      'entry',
      key,
      entries.map((entry) => entry.id)
    )
    for (const entry of entries) {
      worktreeIds.add(entry.worktreeId)
      const table = entry.contentType === 'terminal' ? 'terminalEntry' : 'entry'
      records[table].set(`${key}|${entry.id}`, entry)
    }
  }
  for (const [key, groups] of Object.entries(session.tabGroups ?? {})) {
    listOrder(
      'group',
      key,
      groups.map((group) => group.id)
    )
    groups.forEach((group) => records.group.set(`${key}|${group.id}`, group))
  }
  for (const [key, files] of Object.entries(session.openFilesByWorktree ?? {})) {
    files.forEach((file) => records.file.set(`${key}|${file.filePath}`, file))
  }
  for (const [key, tabs] of Object.entries(session.browserTabsByWorktree ?? {})) {
    tabs.forEach((tab) => records.browser.set(`${key}|${tab.id}`, tab))
  }
  // Records the Loader cannot place in a workspace are carried whole, as one session field.
  const unowned: Record<string, unknown> = {}
  const paneKeys = new Set<string>()
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    if (rowIds.has(tabId)) {
      records.layout.set(tabId, layout)
      collectLayoutLeafIdsInOrder(layout.root).forEach((id) => paneKeys.add(paneKeyOf(tabId, id)))
    } else {
      unowned[tabId] = layout
    }
  }
  const unplacedSleeping: Record<string, unknown> = {}
  for (const [paneKey, record] of Object.entries(session.sleepingAgentSessionsByPaneKey ?? {})) {
    if (paneKeys.has(paneKey)) {
      records.sleeping.set(paneKey, record)
    } else {
      unplacedSleeping[paneKey] = record
    }
  }
  const unplacedIncarnations: Record<string, unknown> = {}
  for (const [paneKey, id] of Object.entries(session.terminalPtyIncarnationsByPaneKey ?? {})) {
    if (paneKeys.has(paneKey)) {
      records.incarnation.set(paneKey, { incarnationId: id })
    } else {
      unplacedIncarnations[paneKey] = id
    }
  }
  const unplacedClosed: Record<string, unknown> = {}
  for (const [tabId, record] of Object.entries(session.closedTerminalTabTombstonesByTabId ?? {})) {
    if (worktreeIds.has(record.worktreeId)) {
      records.closedTab.set(tabId, record)
    } else {
      unplacedClosed[tabId] = record
    }
  }
  records.session.set('session', {
    ...session,
    tabsByWorktree: sortedKeys(session.tabsByWorktree),
    unifiedTabs: sortedKeys(session.unifiedTabs),
    tabGroups: sortedKeys(session.tabGroups),
    openFilesByWorktree: sortedKeys(session.openFilesByWorktree),
    browserTabsByWorktree: sortedKeys(session.browserTabsByWorktree),
    terminalLayoutsByTabId: unowned,
    sleepingAgentSessionsByPaneKey: unplacedSleeping,
    terminalPtyIncarnationsByPaneKey: unplacedIncarnations,
    closedTerminalTabTombstonesByTabId: unplacedClosed
  })
  return records
}

/** JSON with object keys sorted, so key order is not a change. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([left], [right]) => left.localeCompare(right))
        )
      : inner
  )
}

export function diffStoredSession(
  stored: WorkspaceSessionState,
  saved: WorkspaceSessionState
): LayoutLoadChange[] {
  const before = diskRecords(stored)
  const after = diskRecords(saved)
  const changes: LayoutLoadChange[] = []
  const afterByTable = new Map(Object.entries(after))
  for (const [table, oldRecords] of Object.entries(before)) {
    const newRecords = afterByTable.get(table)!
    for (const record of new Set([...oldRecords.keys(), ...newRecords.keys()])) {
      const old = oldRecords.get(record)
      const next = newRecords.get(record)
      if (!old || !next) {
        if (stableJson(old) !== stableJson(next)) {
          changes.push({ table, record, field: '*', before: old, after: next })
        }
        continue
      }
      for (const field of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (stableJson(old[field]) !== stableJson(next[field])) {
          changes.push({ table, record, field, before: old[field], after: next[field] })
        }
      }
    }
  }
  return changes
}
