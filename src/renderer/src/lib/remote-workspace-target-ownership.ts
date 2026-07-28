import type { Repo, Worktree } from '../../../shared/types'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../../shared/execution-host'

export function getRemoteWorkspaceTargetWorktreeIds(
  targetId: string,
  repos: readonly Repo[],
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>
): Set<string> {
  const targetRepos = repos.filter((repo) => repo.connectionId === targetId)
  return new Set(
    Object.values(worktreesByRepo)
      .flat()
      .filter((worktree) =>
        targetRepos.some(
          (repo) =>
            repo.id === worktree.repoId &&
            getWorktreeExecutionHostId(worktree, repo) === getRepoExecutionHostId(repo)
        )
      )
      .map((worktree) => worktree.id)
  )
}
