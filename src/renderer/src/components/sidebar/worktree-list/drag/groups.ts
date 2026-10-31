import { ALL_GROUP_KEY, PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/group-keys'
import { getNaturalWorktreeKeys } from '../../natural-worktree-keys'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { WorktreeDragGroup } from '../../worktree-manual-order'

/** Group members are host identities: same-id copies on two machines are separate cards to reorder. */
export function getWorktreeDragGroups(rows: HostSectionRow[]): WorktreeDragGroup[] {
  const groups: WorktreeDragGroup[] = []
  let current: { key: string; ids: string[] } | null = null
  const naturalWorktreeKeys = getNaturalWorktreeKeys(rows)

  for (const row of rows) {
    if (row.type === 'header') {
      current = { key: row.key, ids: [] }
      groups.push({ key: current.key, worktreeIds: current.ids })
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
    if (row.sectionKey === PINNED_GROUP_KEY && naturalWorktreeKeys.has(worktreeKey)) {
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
  for (const row of rows) {
    if (row.type === 'header') {
      groupIndexes.set(row.key, 0)
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
    const index = groupIndexes.get(row.sectionKey) ?? 0
    groupKeyByRowKey.set(row.rowKey, row.sectionKey)
    groupIndexByRowKey.set(row.rowKey, index)
    groupIndexes.set(row.sectionKey, index + 1)
  }
  return { groupKeyByRowKey, groupIndexByRowKey }
}
