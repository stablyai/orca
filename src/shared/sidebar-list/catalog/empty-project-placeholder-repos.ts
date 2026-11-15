import type { Repo } from '../../repo-types'
import {
  isRepoHidden,
  withoutHiddenFilterRepoIds,
  type HiddenProjects
} from '../../hidden-projects'
import type { Worktree } from '../../worktree/types'
import type { WorktreeGroupBy } from '../row-types'

export function getEmptyProjectPlaceholderRepoIds(args: {
  groupBy: WorktreeGroupBy
  repos: readonly Repo[]
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
  visibleWorktrees: readonly Worktree[]
  filterRepoIds: readonly string[]
  /** Over every loaded repo row: a filter id with no listed copy is ignored, as the row filter does. */
  hiddenProjects: HiddenProjects
  /** Repos whose checkout a VM create in progress has not adopted; its pending row stands for them. */
  pendingVmRepoIds?: ReadonlySet<string>
}): Set<string> {
  if (args.groupBy !== 'repo') {
    return new Set()
  }

  const listedFilterIds = withoutHiddenFilterRepoIds(args.filterRepoIds, args.hiddenProjects)
  const filterSet = listedFilterIds.length > 0 ? new Set(listedFilterIds) : null
  const visibleRepoIds = new Set(args.visibleWorktrees.map((worktree) => worktree.repoId))
  const placeholderRepoIds = new Set<string>()
  for (const repo of args.repos) {
    if (
      (filterSet && !filterSet.has(repo.id)) ||
      args.pendingVmRepoIds?.has(repo.id) ||
      isRepoHidden(repo)
    ) {
      continue
    }
    const hasNoWorktrees = (args.worktreesByRepo[repo.id]?.length ?? 0) === 0
    // Workspace filters must not change persisted Project Group membership (#8865).
    const isFilteredProjectGroupMember = repo.projectGroupId != null && !visibleRepoIds.has(repo.id)
    if (hasNoWorktrees || isFilteredProjectGroupMember) {
      placeholderRepoIds.add(repo.id)
    }
  }
  return placeholderRepoIds
}
