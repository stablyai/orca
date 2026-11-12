import {
  ALL_GROUP_KEY,
  PINNED_GROUP_KEY,
  getProjectGroupHeaderKey
} from '../../../../../../shared/sidebar-list/group-keys'
import { getNaturalWorktreeKeys } from '../listing/natural-worktree-keys'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { WorktreeDragGroup } from './worktree-manual-order'
import { isFolderLaneSectionKey } from '../../../../../../shared/sidebar-list/folder-workspace-occurrences'
import { getFolderWorkspaceHostIdentity } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'

const FOLDER_WORKSPACE_DRAG_GROUP_PREFIX = 'folder-workspaces:'

// Why apart from the section's worktrees: every emitter orders folder workspaces only among themselves.
function getFolderWorkspaceDragGroupKey(sectionKey: string): string {
  return `${FOLDER_WORKSPACE_DRAG_GROUP_PREFIX}${sectionKey}`
}

// Why only under its own project group header: lanes interleave folders of different groups,
// and the drag geometry needs one group's rows to sit together.
export function getFolderWorkspaceRowDragGroupKey(
  sectionKey: string,
  folderWorkspace: { projectGroupId: string }
): string | null {
  return sectionKey === getProjectGroupHeaderKey(folderWorkspace.projectGroupId)
    ? getFolderWorkspaceDragGroupKey(sectionKey)
    : null
}

// Why: the board, status lanes, pin and nesting act only on git worktrees, so these drags only reorder.
export function isFolderWorkspaceDragGroupKey(groupKey: string): boolean {
  return groupKey.startsWith(FOLDER_WORKSPACE_DRAG_GROUP_PREFIX)
}

/** Group members are host identities: same-id copies on two machines are separate cards to reorder.
 * Rows nested under a folder workspace group by their folder's lane, as getWorktreeDragIndexes keys
 * them; every other row groups under the header above it. */
export function getWorktreeDragGroups(rows: HostSectionRow[]): WorktreeDragGroup[] {
  const groups: WorktreeDragGroup[] = []
  let current: { key: string; ids: string[] } | null = null
  let currentFolders: { key: string; ids: string[] } | null = null
  const folderLaneIds = new Map<string, string[]>()
  const naturalWorktreeKeys = getNaturalWorktreeKeys(rows)

  for (const row of rows) {
    if (row.type === 'header') {
      current = { key: row.key, ids: [] }
      currentFolders = null
      groups.push({ key: current.key, worktreeIds: current.ids })
      continue
    }
    if (row.type === 'folder-workspace') {
      const key = getFolderWorkspaceRowDragGroupKey(
        current?.key ?? ALL_GROUP_KEY,
        row.folderWorkspace
      )
      if (!key) {
        continue
      }
      if (!currentFolders) {
        currentFolders = { key, ids: [] }
        groups.push({ key, worktreeIds: currentFolders.ids })
      }
      currentFolders.ids.push(getFolderWorkspaceHostIdentity(row.folderWorkspace))
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
    const worktreeKey = getWorktreeHostIdentity(row.worktree)
    if (row.sectionKey === PINNED_GROUP_KEY && naturalWorktreeKeys.has(worktreeKey)) {
      continue
    }
    if (isFolderLaneSectionKey(row.sectionKey)) {
      let ids = folderLaneIds.get(row.sectionKey)
      if (!ids) {
        ids = []
        folderLaneIds.set(row.sectionKey, ids)
        groups.push({ key: row.sectionKey, worktreeIds: ids })
      }
      ids.push(worktreeKey)
      continue
    }
    if (!current) {
      current = { key: ALL_GROUP_KEY, ids: [] }
      groups.push({ key: current.key, worktreeIds: current.ids })
    }
    current.ids.push(worktreeKey)
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
  const naturalWorktreeKeys = getNaturalWorktreeKeys(rows)
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
      const groupKey = getFolderWorkspaceRowDragGroupKey(sectionKey, row.folderWorkspace)
      if (groupKey) {
        // Folder rows use their host-qualified identity as the row key.
        indexRow(getFolderWorkspaceHostIdentity(row.folderWorkspace), groupKey)
      }
      continue
    }
    if (row.type !== 'item') {
      continue
    }
    if (
      row.sectionKey === PINNED_GROUP_KEY &&
      naturalWorktreeKeys.has(getWorktreeHostIdentity(row.worktree))
    ) {
      continue
    }
    indexRow(row.rowKey, row.sectionKey)
  }
  return { groupKeyByRowKey, groupIndexByRowKey }
}
