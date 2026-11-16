import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/sections/group-keys'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { RenderRow } from './render-row'
import { getFolderWorkspaceWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { Worktree } from '../../../../../../shared/worktree/types'

export type WorktreeItemRow = Extract<HostSectionRow, { type: 'item' }>
export type FolderWorkspaceItemRow = Extract<HostSectionRow, { type: 'folder-workspace' }>
export type WorkspaceItemRow = WorktreeItemRow | FolderWorkspaceItemRow

export function isWorktreeItemRow(row: HostSectionRow): row is WorktreeItemRow {
  return row.type === 'item'
}

export function isWorkspaceItemRow(row: HostSectionRow): row is WorkspaceItemRow {
  return row.type === 'item' || row.type === 'folder-workspace'
}

export function getWorkspaceItemRowWorktree(row: WorkspaceItemRow): Worktree {
  return row.type === 'item' ? row.worktree : getFolderWorkspaceWorktree(row.folderWorkspace)
}

export function getWorkspaceItemRowKey(row: WorkspaceItemRow): string {
  return row.type === 'item' ? row.rowKey : row.key
}

export function isPinnedWorktreeRow(row: WorkspaceItemRow): boolean {
  return row.sectionKey === PINNED_GROUP_KEY
}

// Each visible workspace owns a measured virtual slot, including expanded descendants.
export function buildRenderableRows(rows: HostSectionRow[]): RenderRow[] {
  return rows
}
