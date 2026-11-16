import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { getFolderWorkspaceHostIdentity } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'

import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { RenderRow } from '../listing/render-row'
import type { PinnedWorktreeDisplayPolicy } from '../../../../../../shared/sidebar-list/row-types'
import {
  getWorkspaceItemRowWorktree,
  isPinnedWorktreeRow,
  isWorkspaceItemRow,
  type WorktreeItemRow
} from '../listing/renderable-rows'

export function getRenderRowSidebarKey(row: RenderRow): string | null {
  if (row.type === 'header') {
    return row.key
  }
  if (row.type === 'item') {
    return row.rowKey
  }
  if (row.type === 'folder-workspace') {
    return row.key
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
  if (
    row.type === 'folder-workspace' &&
    (rowKey === folderWorkspaceKey(row.folderWorkspace.id) ||
      rowKey === getFolderWorkspaceHostIdentity(row.folderWorkspace))
  ) {
    return true
  }
  return getRenderRowSidebarKey(row) === rowKey
}

function itemMatchesWorktree(
  item: WorktreeItemRow,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): boolean {
  // Hostless matching is presentation-only legacy fallback; it never routes a workspace action.
  return (
    item.worktree.id === worktreeId &&
    (executionHostId === undefined ||
      getWorktreeExecutionHostId(item.worktree, item.repo) === executionHostId)
  )
}

export function renderRowContainsWorktree(
  row: RenderRow,
  worktreeId: string | null,
  executionHostId?: ExecutionHostId
): boolean {
  if (worktreeId === null) {
    return false
  }
  if (row.type === 'folder-workspace') {
    return (
      folderWorkspaceKey(row.folderWorkspace.id) === worktreeId &&
      (executionHostId === undefined ||
        getFolderWorkspaceHostIdentity(row.folderWorkspace) ===
          composeWorktreeHostIdentity(executionHostId, worktreeId))
    )
  }
  return row.type === 'item' && itemMatchesWorktree(row, worktreeId, executionHostId)
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
    if (
      pinnedDisplayPolicy === 'duplicate-in-groups' &&
      isWorkspaceItemRow(row) &&
      !isPinnedWorktreeRow(row)
    ) {
      return index
    }
  }
  return fallbackIndex
}

export function findPreferredRenderRowIndexForWorktreeIdentity(
  renderRows: readonly RenderRow[],
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): number {
  const identity = getWorktreeHostIdentity(worktree)
  let fallbackIndex = -1
  for (let index = 0; index < renderRows.length; index++) {
    const row = renderRows[index]
    if (!isWorkspaceItemRow(row)) {
      continue
    }
    const candidate = getWorkspaceItemRowWorktree(row)
    const matches =
      row.type === 'folder-workspace' && !worktree.hostId
        ? candidate.id === worktree.id
        : getWorktreeHostIdentity(candidate) === identity
    if (!matches) {
      continue
    }
    if (fallbackIndex === -1) {
      fallbackIndex = index
    }
    if (pinnedDisplayPolicy === 'duplicate-in-groups' && !isPinnedWorktreeRow(row)) {
      return index
    }
  }
  return fallbackIndex
}
