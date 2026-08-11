import type { Worktree } from '../../../../shared/types'

/**
 * Flattens worktreesByRepo into an id lookup.
 *
 * Why: session hydration and terminal reconnect loop over pending worktree ids and
 * previously re-flattened + linear-searched the whole map per iteration, which is
 * O(worktrees x ids) for O(worktrees + ids) distinct work. First entry wins, matching
 * the `.find()` it replaces.
 */
export function buildWorktreeByIdIndex(
  worktreesByRepo: Record<string, Worktree[]>
): Map<string, Worktree> {
  const index = new Map<string, Worktree>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (!index.has(worktree.id)) {
        index.set(worktree.id, worktree)
      }
    }
  }
  return index
}

/** Same first-wins contract as `buildWorktreeByIdIndex`, for any id-bearing row. */
export function buildByIdIndex<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  const index = new Map<string, T>()
  for (const row of rows) {
    if (!index.has(row.id)) {
      index.set(row.id, row)
    }
  }
  return index
}
