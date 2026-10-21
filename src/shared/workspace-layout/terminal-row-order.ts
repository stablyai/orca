import type { WorkspaceSessionState } from '../workspace-session-state-types'

/**
 * Saved terminal rows in the tab groups' order: the groups' tab orders are the tab order, the rows
 * only repeat it. Rows no group lists keep their relative order after the grouped ones. Returns the
 * same session when every row is already in place.
 */
export function orderTerminalRowsByTabGroups(
  session: WorkspaceSessionState
): WorkspaceSessionState {
  let tabsByWorktree: WorkspaceSessionState['tabsByWorktree'] | null = null
  for (const [worktreeId, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    const groups = session.tabGroups?.[worktreeId]
    if (!groups?.length || rows.length < 2) {
      continue
    }
    const rowIdByTabId = new Map(
      (session.unifiedTabs?.[worktreeId] ?? [])
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
    tabsByWorktree ??= { ...session.tabsByWorktree }
    tabsByWorktree[worktreeId] = ordered
  }
  return tabsByWorktree ? { ...session, tabsByWorktree } : session
}
