import type { Repo } from '../../repository/repo-types'
import {
  isRepoHidden,
  withoutHiddenFilterRepoIds,
  type HiddenProjects
} from '../../project/catalog/hidden-projects'
import type { Worktree } from '../../worktree/types'
import type { WorktreeGroupBy } from '../row-types'
import { isDoneWorkspaceStatus } from '../../workspace/status/workspace-statuses'

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
  /** Hide Done removes a grouped repo's only completed workspaces without retiring the membership. */
  hideDoneWorkspaces?: boolean
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
    const worktrees = args.worktreesByRepo[repo.id] ?? []
    const hasNoWorktrees = worktrees.length === 0
    // Workspace filters must not change persisted Project Group membership (#8865).
    const isFilteredProjectGroupMember = repo.projectGroupId != null && !visibleRepoIds.has(repo.id)
    const hiddenOnlyByDone =
      args.hideDoneWorkspaces === true &&
      isFilteredProjectGroupMember &&
      worktrees.length > 0 &&
      worktrees.every((worktree) => isDoneWorkspaceStatus(worktree.workspaceStatus))
    if (hasNoWorktrees || (isFilteredProjectGroupMember && !hiddenOnlyByDone)) {
      placeholderRepoIds.add(repo.id)
    }
  }
  return placeholderRepoIds
}
