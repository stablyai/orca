import type { Worktree } from '../../../../shared/worktree/types'

/** Index once to avoid per-ID flatten scans; first match agrees with find/getIndexedWorktreeMap (STA-4343). Bare IDs cannot distinguish host twins: use getIndexedWorktreesById or explicit hosts for destructive work. */
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
