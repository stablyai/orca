import type { Worktree } from '../../../../shared/worktree/types'

export function buildUnambiguousWorktreeIdIndex(
  worktrees: readonly Worktree[]
): Map<string, Worktree> {
  const index = new Map<string, Worktree>()
  const ambiguous = new Set<string>()
  for (const worktree of worktrees) {
    if (index.has(worktree.id)) {
      index.delete(worktree.id)
      ambiguous.add(worktree.id)
    } else if (!ambiguous.has(worktree.id)) {
      index.set(worktree.id, worktree)
    }
  }
  return index
}
