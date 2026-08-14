import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import type { RenderRow } from '../worktree-list-virtual-rows'
import type { PinnedWorktreeDisplayPolicy } from '../worktree-list-groups'
import { isPinnedWorktreeRow, type WorktreeItemRow } from './render-row-item-rows'

export function getRenderRowSidebarKey(row: RenderRow): string | null {
  if (row.type === 'header') {
    return row.key
  }
  if (row.type === 'item') {
    return row.rowKey
  }
  if (row.type === 'folder-workspace') {
    return folderWorkspaceKey(row.folderWorkspace.id)
  }
  if (row.type === 'pending-creation') {
    return `pending:${row.creationId}`
  }
  if (row.type === 'imported-worktrees-card') {
    return row.key
  }
  if (row.type === 'new-external-worktrees-inbox') {
    return row.key
  }
  return null
}

export function rowKeyMatchesRenderRow(row: RenderRow, rowKey: string): boolean {
  if (row.type === 'lineage-group') {
    return row.rows.some((item) => item.rowKey === rowKey)
  }
  return getRenderRowSidebarKey(row) === rowKey
}

export function renderRowContainsWorktree(row: RenderRow, worktreeId: string | null): boolean {
  if (worktreeId === null) {
    return false
  }
  if (row.type === 'folder-workspace') {
    return folderWorkspaceKey(row.folderWorkspace.id) === worktreeId
  }
  if (row.type === 'lineage-group') {
    return row.rows.some((item) => item.worktree.id === worktreeId)
  }
  return row.type === 'item' && row.worktree.id === worktreeId
}

export function getRenderRowWorktreeItem(
  row: RenderRow,
  worktreeId: string
): WorktreeItemRow | null {
  if (row.type === 'lineage-group') {
    return row.rows.find((item) => item.worktree.id === worktreeId) ?? null
  }
  return row.type === 'item' && row.worktree.id === worktreeId ? row : null
}

// Prefer the worktree's natural group row over its pinned duplicate when both are rendered.
export function findPreferredRenderRowIndexForWorktree(
  renderRows: readonly RenderRow[],
  worktreeId: string,
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): number {
  let fallbackIndex = -1
  for (let index = 0; index < renderRows.length; index++) {
    const row = renderRows[index]
    if (!renderRowContainsWorktree(row, worktreeId)) {
      continue
    }
    if (fallbackIndex === -1) {
      fallbackIndex = index
    }
    const itemRow = getRenderRowWorktreeItem(row, worktreeId)
    if (pinnedDisplayPolicy === 'duplicate-in-groups' && itemRow && !isPinnedWorktreeRow(itemRow)) {
      return index
    }
  }
  return fallbackIndex
}
