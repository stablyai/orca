import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import type { ProjectSectionModel } from '../project-section-grouping'
import { ALL_GROUP_KEY } from './group-keys'
import type { SidebarPRGroupReader, WorktreeGroupBy, WorktreeGroupBySecondary } from './row-types'
import { getGroupKeysForWorktree } from './worktree-group-keys'

export function getRenderedNaturalAnchorRepoIds({
  groupBy,
  worktrees,
  repoMap,
  prGroupOf,
  collapsedGroups,
  workspaceStatuses,
  projectGroups,
  projectGrouping,
  groupBySecondary = 'none'
}: {
  groupBy: WorktreeGroupBy
  worktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  prGroupOf: SidebarPRGroupReader
  collapsedGroups: ReadonlySet<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectGroups: readonly ProjectGroup[]
  projectGrouping?: ProjectSectionModel
  groupBySecondary?: WorktreeGroupBySecondary
}): Set<string> {
  const renderedRepoIds = new Set<string>()
  if (groupBy === 'none') {
    if (!collapsedGroups.has(ALL_GROUP_KEY)) {
      for (const worktree of worktrees) {
        renderedRepoIds.add(worktree.repoId)
      }
    }
    return renderedRepoIds
  }
  if (groupBy === 'repo') {
    for (const worktree of worktrees) {
      renderedRepoIds.add(worktree.repoId)
    }
    return renderedRepoIds
  }
  for (const worktree of worktrees) {
    const groupKeys = getGroupKeysForWorktree(
      groupBy,
      worktree,
      repoMap,
      prGroupOf,
      workspaceStatuses,
      projectGroups,
      projectGrouping,
      groupBySecondary
    )
    if (groupKeys.length > 0 && groupKeys.every((key) => !collapsedGroups.has(key))) {
      renderedRepoIds.add(worktree.repoId)
    }
  }
  return renderedRepoIds
}

export function orderMainWorktreeFirst<T extends { isMainWorktree?: boolean }>(
  worktrees: T[]
): T[] {
  const mainWorktrees = worktrees.filter((worktree) => worktree.isMainWorktree)
  if (mainWorktrees.length === 0) {
    return worktrees
  }
  // Keep canonical workspaces first for repo-scanned project groups despite dynamic child ranking.
  return [...mainWorktrees, ...worktrees.filter((worktree) => !worktree.isMainWorktree)]
}
