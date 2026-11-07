import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { isFolderRepo } from '../../../../../../shared/repo-kind'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

type GroupRepo = Pick<Repo, 'id' | 'projectGroupId' | 'kind' | 'connectionId' | 'executionHostId'>
type GroupWorktree = Pick<Worktree, 'id' | 'repoId' | 'isMainWorktree' | 'isArchived'>

/** Main checkouts of the other Git projects in the active project's group, on the same host. */
export function findGroupLinkedWorktreeIds(
  repos: readonly GroupRepo[],
  worktrees: readonly GroupWorktree[],
  activeWorktreeId: string
): string[] {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const active = worktrees.find((worktree) => worktree.id === activeWorktreeId)
  const activeRepo = active ? repoById.get(active.repoId) : undefined
  const groupId = activeRepo?.projectGroupId
  if (!activeRepo || !groupId) {
    return []
  }
  const hostId = getRepoExecutionHostId(activeRepo)
  return worktrees.flatMap((worktree) => {
    const repo = repoById.get(worktree.repoId)
    return repo &&
      repo.id !== activeRepo.id &&
      repo.projectGroupId === groupId &&
      !isFolderRepo(repo) &&
      getRepoExecutionHostId(repo) === hostId &&
      worktree.isMainWorktree &&
      !worktree.isArchived
      ? [worktree.id]
      : []
  })
}
