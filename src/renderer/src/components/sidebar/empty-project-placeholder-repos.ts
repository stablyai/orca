import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeGroupBy } from './worktree-list/grouping/row-types'
import { isDefaultBranchWorkspace } from './default-branch-workspace'

export function getEmptyProjectPlaceholderRepoIds(args: {
  groupBy: WorktreeGroupBy
  repos: readonly Repo[]
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
  visibleWorktrees: readonly Worktree[]
  filterRepoIds: readonly string[]
  hideDefaultBranchWorkspace: boolean
}): Set<string> {
  if (args.groupBy !== 'repo') {
    return new Set()
  }

  const filterSet = args.filterRepoIds.length > 0 ? new Set(args.filterRepoIds) : null
  const visibleRepoIds = new Set(args.visibleWorktrees.map((worktree) => worktree.repoId))
  const placeholderRepoIds = new Set<string>()
  for (const repo of args.repos) {
    if (filterSet && !filterSet.has(repo.id)) {
      continue
    }
    const hasNoWorktrees = (args.worktreesByRepo[repo.id]?.length ?? 0) === 0
    // Why: workspace filters hide cards, but must not rewrite the visible
    // membership of a persisted Project Group. #8865
    const isFilteredProjectGroupMember = repo.projectGroupId != null && !visibleRepoIds.has(repo.id)
    // Why: "Hide default branch" hides rows, not projects — every repo whose only
    // live rows are default checkouts keeps a header, which is what lets the
    // add-project handoff reveal an import without flipping the user's filter.
    const isHiddenDefaultCheckoutOnly =
      args.hideDefaultBranchWorkspace &&
      !visibleRepoIds.has(repo.id) &&
      hasOnlyDefaultCheckoutRows(args.worktreesByRepo[repo.id])
    if (hasNoWorktrees || isFilteredProjectGroupMember || isHiddenDefaultCheckoutOnly) {
      placeholderRepoIds.add(repo.id)
    }
  }
  return placeholderRepoIds
}

// Why skip archived rows (unlike hasNoWorktrees): the sidebar drops them before any filter, so they never count as a live row.
function hasOnlyDefaultCheckoutRows(worktrees: readonly Worktree[] | undefined): boolean {
  const liveWorktrees = (worktrees ?? []).filter((worktree) => !worktree.isArchived)
  return liveWorktrees.length > 0 && liveWorktrees.every(isDefaultBranchWorkspace)
}
