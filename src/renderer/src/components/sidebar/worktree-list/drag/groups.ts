import { ALL_GROUP_KEY, PINNED_GROUP_KEY } from '../grouping/group-keys'
import { getNaturalWorktreeIds } from '../../natural-worktree-ids'
import type { HostSectionRow } from '../../host-section-rows'
import type { WorktreeDragGroup } from '../../worktree-manual-order'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'

const FOLDER_WORKSPACE_DRAG_GROUP_PREFIX = 'folder-workspaces:'

// Why apart from the section's worktrees: every emitter orders folder workspaces only among themselves.
export function getFolderWorkspaceDragGroupKey(sectionKey: string): string {
  return `${FOLDER_WORKSPACE_DRAG_GROUP_PREFIX}${sectionKey}`
}

// Why: the board, status lanes, pin and nesting act only on git worktrees, so these drags only reorder.
export function isFolderWorkspaceDragGroupKey(groupKey: string): boolean {
  return groupKey.startsWith(FOLDER_WORKSPACE_DRAG_GROUP_PREFIX)
}

export function getWorktreeDragGroups(rows: HostSectionRow[]): WorktreeDragGroup[] {
  const groups: WorktreeDragGroup[] = []
  let current: { key: string; ids: string[] } | null = null
  let currentFolders: { key: string; ids: string[] } | null = null
  const naturalWorktreeIds = getNaturalWorktreeIds(rows)

  for (const row of rows) {
    if (row.type === 'header') {
      current = { key: row.key, ids: [] }
      currentFolders = null
      groups.push({ key: current.key, worktreeIds: current.ids })
      continue
    }
    if (row.type === 'folder-workspace') {
      if (!currentFolders) {
        const key = getFolderWorkspaceDragGroupKey(current?.key ?? ALL_GROUP_KEY)
        currentFolders = { key, ids: [] }
        groups.push({ key, worktreeIds: currentFolders.ids })
      }
      currentFolders.ids.push(folderWorkspaceKey(row.folderWorkspace.id))
      continue
    }
    if (
      row.type === 'host-header' ||
      row.type === 'imported-worktrees-card' ||
      row.type === 'new-external-worktrees-inbox' ||
      row.type === 'pending-creation'
    ) {
      continue
    }
    if (row.sectionKey === PINNED_GROUP_KEY && naturalWorktreeIds.has(row.worktree.id)) {
      continue
    }
    if (!current) {
      current = { key: ALL_GROUP_KEY, ids: [] }
      groups.push({ key: current.key, worktreeIds: current.ids })
    }
    current.ids.push(row.worktree.id)
  }

  return groups.filter((group) => group.worktreeIds.length > 0)
}

export function getWorktreeDragIndexes(rows: readonly HostSectionRow[]): {
  groupKeyByRowKey: Map<string, string>
  groupIndexByRowKey: Map<string, number>
} {
  const groupKeyByRowKey = new Map<string, string>()
  const groupIndexByRowKey = new Map<string, number>()
  const groupIndexes = new Map<string, number>()
  const naturalWorktreeIds = getNaturalWorktreeIds(rows)
  const indexRow = (rowKey: string, groupKey: string): void => {
    const index = groupIndexes.get(groupKey) ?? 0
    groupKeyByRowKey.set(rowKey, groupKey)
    groupIndexByRowKey.set(rowKey, index)
    groupIndexes.set(groupKey, index + 1)
  }
  let sectionKey = ALL_GROUP_KEY
  for (const row of rows) {
    if (row.type === 'header') {
      sectionKey = row.key
      groupIndexes.set(row.key, 0)
      groupIndexes.set(getFolderWorkspaceDragGroupKey(row.key), 0)
      continue
    }
    if (row.type === 'folder-workspace') {
      // Folder rows use their synthetic worktree id as the row key.
      indexRow(
        folderWorkspaceKey(row.folderWorkspace.id),
        getFolderWorkspaceDragGroupKey(sectionKey)
      )
      continue
    }
    if (row.type !== 'item') {
      continue
    }
    if (row.sectionKey === PINNED_GROUP_KEY && naturalWorktreeIds.has(row.worktree.id)) {
      continue
    }
    indexRow(row.rowKey, row.sectionKey)
  }
  return { groupKeyByRowKey, groupIndexByRowKey }
}
