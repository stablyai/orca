import { getProjectRepoFilterHost } from '../project-repo-filter-selection'
import { getRepoHostIdentity, getRepoHostIdentityForParts } from '../repo-host-identity'
import { getWorktreeExecutionHostId } from '../execution-host'
import { projectRepoFilterMatcher } from '../project-grouping'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import type { WorktreeGroupBy } from './row-types'

export function getEmptyProjectPlaceholderRepoIds(args: {
  groupBy: WorktreeGroupBy
  repos: readonly Repo[]
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
  visibleWorktrees: readonly Worktree[]
  filterRepoIds: readonly string[]
}): Set<string> {
  if (args.groupBy !== 'repo') {
    return new Set()
  }

  const matchesRepo = projectRepoFilterMatcher(args.filterRepoIds)
  const visibleRepoIds = new Set(
    args.visibleWorktrees.map((worktree) =>
      getRepoHostIdentityForParts(worktree.repoId, getWorktreeExecutionHostId(worktree, undefined))
    )
  )
  const populated = new Set(
    Object.values(args.worktreesByRepo).flatMap((rows) =>
      (rows ?? []).map((row) =>
        getRepoHostIdentityForParts(row.repoId, getWorktreeExecutionHostId(row, undefined))
      )
    )
  )
  const placeholderRepoIds = new Set<string>()
  for (const repo of args.repos) {
    if (!matchesRepo(repo.id, getProjectRepoFilterHost(repo))) {
      continue
    }
    const hasNoWorktrees = !populated.has(getRepoHostIdentity(repo))
    // Workspace filters must not change persisted Project Group membership (#8865).
    const isFilteredProjectGroupMember =
      repo.projectGroupId != null && !visibleRepoIds.has(getRepoHostIdentity(repo))
    if (hasNoWorktrees || isFilteredProjectGroupMember) {
      placeholderRepoIds.add(getRepoHostIdentity(repo))
    }
  }
  return placeholderRepoIds
}
