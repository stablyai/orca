import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  folderWorkspaceToWorktree,
  getFolderWorkspaceHostIdentity
} from '../../../../../../shared/folder-workspace-worktree'
import { getWorktreeExecutionHostId } from '../../../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { RenderRow } from '../listing/render-row'
import type { PinnedWorktreeDisplayPolicy } from '../grouping/row-types'
import { isPinnedWorktreeRow, type WorktreeItemRow } from '../listing/renderable-rows'

export function getRenderRowSidebarKey(row: RenderRow): string | null {
  if (row.type === 'header') {
    return row.key
  }
  if (row.type === 'item') {
    return row.rowKey
  }
  if (row.type === 'folder-workspace') {
    return getFolderWorkspaceHostIdentity(row.folderWorkspace)
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
  if (row.type === 'folder-workspace' && rowKey === folderWorkspaceKey(row.folderWorkspace.id)) {
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
  if (row.type === 'lineage-group') {
    return row.rows.some((item) => itemMatchesWorktree(item, worktreeId, executionHostId))
  }
  return row.type === 'item' && itemMatchesWorktree(row, worktreeId, executionHostId)
}

export function getRenderRowWorktreeItem(
  row: RenderRow,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): WorktreeItemRow | null {
  if (row.type === 'lineage-group') {
    return row.rows.find((item) => itemMatchesWorktree(item, worktreeId, executionHostId)) ?? null
  }
  return row.type === 'item' && itemMatchesWorktree(row, worktreeId, executionHostId) ? row : null
}

// Prefer the worktree's natural group row over its pinned duplicate when both are rendered.
// When `isVisibleRow` is given, an already-visible copy wins: a reveal must not yank the
// viewport away from the duplicate the user is looking at (issue #24852).
export function findPreferredRenderRowIndexForWorktree(
  renderRows: readonly RenderRow[],
  worktreeId: string,
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy,
  isVisibleRow?: (row: RenderRow) => boolean
): number {
  let fallbackIndex = -1
  let visibleIndex = -1
  let naturalGroupIndex = -1
  for (let index = 0; index < renderRows.length; index++) {
    const row = renderRows[index]
    if (!renderRowContainsWorktree(row, worktreeId)) {
      continue
    }
    if (fallbackIndex === -1) {
      fallbackIndex = index
    }
    if (visibleIndex === -1 && isVisibleRow?.(row)) {
      visibleIndex = index
    }
    const itemRow = getRenderRowWorktreeItem(row, worktreeId)
    if (
      naturalGroupIndex === -1 &&
      pinnedDisplayPolicy === 'duplicate-in-groups' &&
      itemRow &&
      !isPinnedWorktreeRow(itemRow)
    ) {
      naturalGroupIndex = index
    }
  }
  return visibleIndex !== -1
    ? visibleIndex
    : naturalGroupIndex !== -1
      ? naturalGroupIndex
      : fallbackIndex
}

export function findPreferredRenderRowIndexForWorktreeIdentity(
  renderRows: readonly RenderRow[],
  worktree: Pick<Worktree, 'id' | 'hostId'>,
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy,
  isVisibleRow?: (row: RenderRow) => boolean
): number {
  const identity = getWorktreeHostIdentity(worktree)
  let fallbackIndex = -1
  let visibleIndex = -1
  let naturalGroupIndex = -1
  for (let index = 0; index < renderRows.length; index++) {
    const row = renderRows[index]
    // Why: host-qualified reveals are emitted for folder workspaces too, and a
    // walker that only knows item rows returns -1 so the reveal never lands.
    if (row.type === 'folder-workspace') {
      if (
        folderWorkspaceKey(row.folderWorkspace.id) === worktree.id &&
        (!worktree.hostId ||
          getWorktreeHostIdentity(folderWorkspaceToWorktree(row.folderWorkspace)) === identity)
      ) {
        // Why: duplicate folder rows follow the same visible-copy preference as item
        // rows — a reveal must not yank the viewport off the copy the user sees (#24852).
        if (fallbackIndex === -1) {
          fallbackIndex = index
        }
        if (visibleIndex === -1 && isVisibleRow?.(row)) {
          visibleIndex = index
        }
      }
      continue
    }
    const itemRows = row.type === 'lineage-group' ? row.rows : row.type === 'item' ? [row] : []
    const itemRow = itemRows.find(
      (candidate) => getWorktreeHostIdentity(candidate.worktree) === identity
    )
    if (!itemRow) {
      continue
    }
    if (fallbackIndex === -1) {
      fallbackIndex = index
    }
    if (visibleIndex === -1 && isVisibleRow?.(row)) {
      visibleIndex = index
    }
    if (
      naturalGroupIndex === -1 &&
      pinnedDisplayPolicy === 'duplicate-in-groups' &&
      !isPinnedWorktreeRow(itemRow)
    ) {
      naturalGroupIndex = index
    }
  }
  return visibleIndex !== -1
    ? visibleIndex
    : naturalGroupIndex !== -1
      ? naturalGroupIndex
      : fallbackIndex
}
