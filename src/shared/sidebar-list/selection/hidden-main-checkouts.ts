import type { Repo } from '../../repository/repo-types'
import type { Worktree } from '../../worktree/types'
import { isDefaultBranchWorkspace } from '../../worktree/visibility/workspace-kinds'

/** Default-branch checkouts the row filters dropped; they hold their project's chats, so their activity still ranks it. */
export function getHiddenMainCheckouts(
  repos: readonly Repo[],
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>,
  visibleWorktrees: readonly Worktree[]
): Worktree[] {
  const visibleIds = new Set(visibleWorktrees.map((worktree) => worktree.id))
  return repos.flatMap(
    (repo) =>
      worktreesByRepo[repo.id]?.filter(
        (worktree) => isDefaultBranchWorkspace(worktree, repo) && !visibleIds.has(worktree.id)
      ) ?? []
  )
}
