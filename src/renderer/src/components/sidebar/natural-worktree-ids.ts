import { PINNED_GROUP_KEY } from '../../../../shared/sidebar-list/group-keys'

type NaturalWorktreeIdRow = { type: string } & Partial<{
  sectionKey: string
  worktree: { id: string }
}>

/** Pinned duplicates have no separate natural drag slot; avoid allocating arrays per row during rebuilds. */
export function getNaturalWorktreeIds(rows: readonly NaturalWorktreeIdRow[]): Set<string> {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY && row.worktree) {
      ids.add(row.worktree.id)
    }
  }
  return ids
}
