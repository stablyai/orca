import type { HostSectionRow } from './host-section-rows'
import { PINNED_GROUP_KEY } from './worktree-list-groups'

export function getWorktreeDragIndexes(rows: readonly HostSectionRow[]): {
  groupKeyByRowKey: Map<string, string>
  groupIndexByRowKey: Map<string, number>
} {
  const groupKeyByRowKey = new Map<string, string>()
  const groupIndexByRowKey = new Map<string, number>()
  const groupIndexes = new Map<string, number>()
  const naturalWorktreeIds = new Set(
    rows.flatMap((row) =>
      row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY ? [row.worktree.id] : []
    )
  )
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
