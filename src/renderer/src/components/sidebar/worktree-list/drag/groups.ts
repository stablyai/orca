import {
  ALL_GROUP_KEY,
  PINNED_GROUP_KEY
} from '../../../../../../shared/sidebar-list/sections/group-keys'
import { getNaturalWorktreeKeys } from '../listing/natural-worktree-keys'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { WorktreeDragGroup } from './worktree-manual-order'
import { isFolderLaneSectionKey } from '../../../../../../shared/sidebar-list/folders/folder-workspace-occurrences'

/** Group members are host identities: same-id copies on two machines are separate cards to reorder.
 * Rows nested under a folder workspace group by their folder's lane, as getWorktreeDragIndexes keys
 * them; every other row groups under the header above it. */
export function getWorktreeDragGroups(rows: HostSectionRow[]): WorktreeDragGroup[] {
  const groups: WorktreeDragGroup[] = []
  let currentKey: string | null = null
  let currentIds: string[] | null = null
  let folderLaneIds: Map<string, string[]> | undefined
  let naturalWorktreeKeys: Set<string> | undefined

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (row.type === 'header') {
      currentKey = row.key
      currentIds = null
      continue
    }
    if (
      row.type === 'host-header' ||
      row.type === 'imported-worktrees-card' ||
      row.type === 'new-external-worktrees-inbox' ||
      row.type === 'pending-creation' ||
      row.type === 'folder-workspace'
    ) {
      continue
    }
    const worktreeKey = getWorktreeHostIdentity(row.worktree)
    if (row.sectionKey === PINNED_GROUP_KEY) {
      naturalWorktreeKeys ??= getNaturalWorktreeKeys(rows)
      if (naturalWorktreeKeys.has(worktreeKey)) {
        continue
      }
    }
    if (isFolderLaneSectionKey(row.sectionKey)) {
      folderLaneIds ??= new Map<string, string[]>()
      let ids = folderLaneIds.get(row.sectionKey)
      if (!ids) {
        ids = []
        folderLaneIds.set(row.sectionKey, ids)
        groups.push({ key: row.sectionKey, worktreeIds: ids })
      }
      ids.push(worktreeKey)
      continue
    }
    if (!currentIds) {
      currentIds = []
      groups.push({ key: currentKey ?? ALL_GROUP_KEY, worktreeIds: currentIds })
    }
    currentIds.push(worktreeKey)
  }

  return groups
}

export function getWorktreeDragIndexes(rows: readonly HostSectionRow[]): {
  groupKeyByRowKey: Map<string, string>
  groupIndexByRowKey: Map<string, number>
} {
  const groupKeyByRowKey = new Map<string, string>()
  const groupIndexByRowKey = new Map<string, number>()
  let groupIndexes: Map<string, number> | undefined
  let lastSectionKey: string | undefined
  let lastSectionCount = 0
  let naturalWorktreeKeys: Set<string> | undefined
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (row.type === 'header') {
      if (lastSectionKey !== undefined && lastSectionKey !== row.key) {
        ;(groupIndexes ??= new Map()).set(lastSectionKey, lastSectionCount)
      }
      lastSectionKey = row.key
      lastSectionCount = 0
      groupIndexes?.set(row.key, 0)
      continue
    }
    if (row.type !== 'item') {
      continue
    }
    if (row.sectionKey === PINNED_GROUP_KEY) {
      naturalWorktreeKeys ??= getNaturalWorktreeKeys(rows)
      if (naturalWorktreeKeys.has(getWorktreeHostIdentity(row.worktree))) {
        continue
      }
    }
    const sectionKey = row.sectionKey
    if (sectionKey !== lastSectionKey) {
      if (lastSectionKey !== undefined) {
        ;(groupIndexes ??= new Map()).set(lastSectionKey, lastSectionCount)
      }
      lastSectionKey = sectionKey
      lastSectionCount = groupIndexes?.get(sectionKey) ?? 0
    }
    groupKeyByRowKey.set(row.rowKey, sectionKey)
    groupIndexByRowKey.set(row.rowKey, lastSectionCount)
    lastSectionCount += 1
  }
  return { groupKeyByRowKey, groupIndexByRowKey }
}
