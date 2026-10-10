import { getFolderWorkspaceHostIdentity } from '../../../../../../shared/folder-workspace-worktree'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { HostSectionRow } from '../../host-section-rows'
import type { WorktreeDragUnitGroup } from '../../worktree-drag-units'
import { ALL_GROUP_KEY } from '../grouping/group-keys'

const FOLDER_WORKSPACE_DRAG_GROUP_PREFIX = 'folder-workspaces:'

export function isFolderWorkspaceDragGroupKey(groupKey: string): boolean {
  return groupKey.startsWith(FOLDER_WORKSPACE_DRAG_GROUP_PREFIX)
}

/**
 * Folder workspace rows reorder only among adjacent siblings of the same project
 * group under the same header, so each contiguous run is its own drag group.
 * Ids are workspace keys, matching the manual-order catalog.
 */
export function getFolderWorkspaceDragGroups(rows: readonly HostSectionRow[]): {
  groups: WorktreeDragUnitGroup[]
  groupKeyByRowKey: Map<string, string>
  groupIndexByRowKey: Map<string, number>
} {
  const groups: WorktreeDragUnitGroup[] = []
  const groupKeyByRowKey = new Map<string, string>()
  const groupIndexByRowKey = new Map<string, number>()
  const usedKeys = new Set<string>()
  let headerKey = ALL_GROUP_KEY
  let current: {
    group: WorktreeDragUnitGroup
    ids: string[]
    projectGroupId: string
  } | null = null

  for (const row of rows) {
    if (row.type === 'header') {
      headerKey = row.key
    }
    if (row.type !== 'folder-workspace') {
      current = null
      continue
    }
    const projectGroupId = row.folderWorkspace.projectGroupId
    if (!current || current.projectGroupId !== projectGroupId) {
      const baseKey = `${FOLDER_WORKSPACE_DRAG_GROUP_PREFIX}${headerKey}:${projectGroupId}`
      let key = baseKey
      // Why: lanes in other Group by modes can interleave project groups.
      for (let run = 1; usedKeys.has(key); run++) {
        key = `${baseKey}:${run}`
      }
      usedKeys.add(key)
      const ids: string[] = []
      current = { group: { key, worktreeIds: ids, units: [] }, ids, projectGroupId }
      groups.push(current.group)
    }
    const worktreeId = folderWorkspaceKey(row.folderWorkspace.id)
    const rowKey = getFolderWorkspaceHostIdentity(row.folderWorkspace)
    groupKeyByRowKey.set(rowKey, current.group.key)
    groupIndexByRowKey.set(rowKey, current.ids.length)
    current.ids.push(worktreeId)
    current.group.units.push({ worktreeId, worktreeIds: [worktreeId] })
  }

  return { groups, groupKeyByRowKey, groupIndexByRowKey }
}
