import { getProjectGroupingForRepo, type ProjectGroupingIndex } from '../project-section-grouping'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import type { PendingCreationRef, WorktreeGroupBy } from './row-types'

/** Retain sections with explicit workspaces or pending creations when empty projects are hidden. */
export function buildSidebarProjectVisibility(
  inputs: {
    hideEmptyProjects?: boolean
    groupBy: WorktreeGroupBy
    worktrees: readonly Worktree[]
    pendingCreations: readonly PendingCreationRef[]
    repoMap: Map<string, Repo>
  },
  projectIndex: ProjectGroupingIndex | null
) {
  const pendingByRepo = new Map<string, PendingCreationRef[]>()
  for (const creation of inputs.pendingCreations) {
    const list = pendingByRepo.get(creation.repoId) ?? []
    list.push(creation)
    pendingByRepo.set(creation.repoId, list)
  }
  const keptProjects =
    inputs.hideEmptyProjects && inputs.groupBy === 'repo'
      ? new Set(
          [...inputs.worktrees.map((worktree) => worktree.repoId), ...pendingByRepo.keys()].map(
            (repoId) => getProjectGroupingForRepo(repoId, inputs.repoMap, projectIndex).key
          )
        )
      : null
  return { pendingByRepo, keptProjects }
}
