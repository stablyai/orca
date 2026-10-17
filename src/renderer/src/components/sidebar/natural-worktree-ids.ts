import {
  NEEDS_ATTENTION_GROUP_KEY,
  PINNED_GROUP_KEY
} from '../../../../shared/sidebar-list/group-keys'

/** The row shape both drag models share: only `item` rows carry a worktree and a section. */
type NaturalWorktreeIdRow = { type: string } & Partial<{
  sectionKey: string
  worktree: { id: string }
}>

/**
 * Ids of worktrees rendered in their own group.
 *
 * Why: a pinned duplicate of a worktree that also renders in its natural group is not its own drag
 * slot. Shared by every drag model so the rule lives in one place, and built with a loop rather
 * than `flatMap` — that allocated a throwaway array per row, four times per row-model rebuild.
 */
export function getNaturalWorktreeIds(rows: readonly NaturalWorktreeIdRow[]): Set<string> {
  const ids = new Set<string>()
  for (const row of rows) {
    if (
      row.type === 'item' &&
      row.sectionKey !== PINNED_GROUP_KEY &&
      row.sectionKey !== NEEDS_ATTENTION_GROUP_KEY &&
      row.worktree
    ) {
      ids.add(row.worktree.id)
    }
  }
  return ids
}

/**
 * Whether an item row only echoes a workspace that owns a row elsewhere, so it is never a drag slot.
 * "Needs you" rows always echo; a pinned row echoes only when its natural-group copy also renders.
 */
export function isEchoSectionRow(
  row: { sectionKey: string; worktree: { id: string } },
  naturalWorktreeIds: ReadonlySet<string>
): boolean {
  return (
    row.sectionKey === NEEDS_ATTENTION_GROUP_KEY ||
    (row.sectionKey === PINNED_GROUP_KEY && naturalWorktreeIds.has(row.worktree.id))
  )
}
