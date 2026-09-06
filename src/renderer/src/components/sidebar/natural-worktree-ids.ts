import { PINNED_GROUP_KEY } from './worktree-list/grouping/group-keys'
import { isCollectionSectionKey } from './worktree-list-collections'

/** The row shape both drag models share: only `item` rows carry a worktree and a section. */
type NaturalWorktreeIdRow = { type: string } & Partial<{
  sectionKey: string
  worktree: { id: string }
}>

/**
 * Ids of worktrees rendered in their own group.
 *
 * Why: a pinned duplicate of a worktree that also renders in its natural group is not its own drag
 * slot; a collection row is the same kind of duplicate. Shared by every drag model so the rule
 * lives in one place, and built with a loop rather than `flatMap` — that allocated a throwaway
 * array per row, four times per row-model rebuild.
 */
export function getNaturalWorktreeIds(rows: readonly NaturalWorktreeIdRow[]): Set<string> {
  const ids = new Set<string>()
  for (const row of rows) {
    if (
      row.type === 'item' &&
      row.sectionKey !== PINNED_GROUP_KEY &&
      !isCollectionSectionKey(row.sectionKey) &&
      row.worktree
    ) {
      ids.add(row.worktree.id)
    }
  }
  return ids
}
