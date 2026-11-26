import type { Repo } from '../../repository/repo-types'
import type { Worktree } from '../../worktree/types'
import { isDefaultBranchWorkspace } from '../../worktree/visibility/workspace-kinds'
import { getWorktreeHostIdentity } from '../../worktree/host-qualified-identity'
import {
  getRepoExecutionHostIdOrDefault,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../execution-host/execution-host'

/**
 * Default-branch checkouts the row filters dropped; they hold their project's chats, so their
 * activity still ranks it. Only a listed registration's own host counts: a copy of the same
 * project on a host the view leaves out must not reorder it.
 */
export function getHiddenMainCheckouts(
  rows: {
    /** The listed registrations, one per shown host. */
    repos: readonly Repo[]
    worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
    visibleWorktrees: readonly Worktree[]
  },
  defaultHostId: ExecutionHostId
): Worktree[] {
  // Host-qualified: the same id can be shown on one host and hidden on another.
  const visible = new Set(rows.visibleWorktrees.map(getWorktreeHostIdentity))
  return rows.repos.flatMap((repo) => {
    const repoHostId = getRepoExecutionHostIdOrDefault(repo, defaultHostId)
    return (
      rows.worktreesByRepo[repo.id]?.filter(
        (worktree) =>
          isDefaultBranchWorkspace(worktree, repo) &&
          getWorktreeExecutionHostId(worktree, repo, defaultHostId) === repoHostId &&
          !visible.has(getWorktreeHostIdentity(worktree))
      ) ?? []
    )
  })
}
