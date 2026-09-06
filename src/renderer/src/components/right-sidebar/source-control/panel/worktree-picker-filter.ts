import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'

/** Every searchable token for a worktree row: name, path, comment and current branch. */
export function getSourceControlWorktreeSearchText(worktree: Worktree): string {
  const identity = getWorktreeGitIdentityDisplay(worktree)
  const headLabel =
    identity?.kind === 'branch'
      ? identity.branchName
      : identity?.kind === 'detached'
        ? identity.sourceControlLabel
        : ''
  return [worktree.displayName, worktree.path, worktree.comment, headLabel]
    .filter((part) => part.length > 0)
    .join('\n')
    .toLowerCase()
}

/** Case-insensitive substring filter over name/path/comment/branch for the picker. */
export function filterSourceControlWorktrees(
  worktrees: readonly Worktree[],
  rawQuery: string
): readonly Worktree[] {
  const query = rawQuery.trim().toLowerCase()
  if (!query) {
    return worktrees
  }
  return worktrees.filter((worktree) =>
    getSourceControlWorktreeSearchText(worktree).includes(query)
  )
}
