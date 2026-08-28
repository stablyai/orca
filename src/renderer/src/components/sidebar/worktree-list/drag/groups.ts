import { ALL_GROUP_KEY, PINNED_GROUP_KEY } from '../grouping/group-keys'
import type { HostSectionRow } from '../../host-section-rows'
import type { WorktreeDragGroup } from '../../worktree-manual-order'

// A pinned duplicate of a worktree that also renders in its natural group is not its own drag slot.
function getNaturalWorktreeIds(rows: readonly HostSectionRow[]): Set<string> {
  return new Set(
    rows.flatMap((row) =>
      row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY ? [row.worktree.id] : []
    )
  )
}

export function getWorktreeDragGroups(rows: HostSectionRow[]): WorktreeDragGroup[] {
  const groups: WorktreeDragGroup[] = []
  let current: { key: string; ids: string[] } | null = null
  const naturalWorktreeIds = getNaturalWorktreeIds(rows)

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
  for (const row of rows) {
    if (row.type === 'header') {
      groupIndexes.set(row.key, 0)
      continue
    }
    if (row.type !== 'item') {
      continue
    }
    if (row.sectionKey === PINNED_GROUP_KEY && naturalWorktreeIds.has(row.worktree.id)) {
      continue
    }
    const index = groupIndexes.get(row.sectionKey) ?? 0
    groupKeyByRowKey.set(row.rowKey, row.sectionKey)
    groupIndexByRowKey.set(row.rowKey, index)
    groupIndexes.set(row.sectionKey, index + 1)
  }
  return { groupKeyByRowKey, groupIndexByRowKey }
}
