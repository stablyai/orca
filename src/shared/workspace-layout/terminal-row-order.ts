import { SessionUnitReader } from '../session-unit-reader'
import { SessionUnitIndex } from '../session-unit-index'
import type { WorkspaceSessionState } from '../workspace-session-state-types'

/** Group tab orders are authoritative; unlisted rows retain order afterwards. Return the same session when already ordered. */
export function orderTerminalRowsByTabGroups(
  session: WorkspaceSessionState
): WorkspaceSessionState {
  const reader = new SessionUnitReader(session, new SessionUnitIndex(session))
  reduceTerminalRowOrder(reader, Object.keys(session.tabsByWorktree ?? {}))
  return reader.snapshot()
}

export function reduceTerminalRowOrder(reader: SessionUnitReader, owners: Iterable<string>): void {
  for (const worktreeId of owners) {
    const rows = reader.unit('tabsByWorktree', worktreeId).value
    if (!rows) {
      continue
    }
    const groups = reader.unit('tabGroups', worktreeId).value
    if (!groups?.length || rows.length < 2) {
      continue
    }
    const rowIdByTabId = new Map(
      (reader.unit('unifiedTabs', worktreeId).value ?? [])
        .filter((tab) => tab.contentType === 'terminal')
        .map((tab) => [tab.id, tab.entityId ?? tab.id])
    )
    const rowIds = new Set(rows.map((row) => row.id))
    const position = new Map<string, number>()
    for (const tabId of groups.flatMap((group) => group.tabOrder)) {
      // A headless host saves rows but no tab bar; its group moves list the row ids directly.
      const rowId = rowIdByTabId.get(tabId) ?? (rowIds.has(tabId) ? tabId : undefined)
      if (rowId && !position.has(rowId)) {
        position.set(rowId, position.size)
      }
    }
    const ordered = rows
      .map((row, index) => ({ row, rank: position.get(row.id) ?? position.size + index }))
      .sort((left, right) => left.rank - right.rank)
      .map(({ row }, sortOrder) => (row.sortOrder === sortOrder ? row : { ...row, sortOrder }))
    if (ordered.every((row, index) => row === rows[index])) {
      continue
    }
    reader.write('tabsByWorktree', worktreeId, { present: true, value: ordered })
  }
}
