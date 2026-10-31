import { useAppStore } from '@/store'
import type { ProjectGroupingSettings } from '../../../../shared/project-grouping'
import {
  buildRepoProjectGroupingIndex,
  type ProjectGroupingIndex
} from '../../../../shared/project-section-grouping'
import type { Repo } from '../../../../shared/repo-types'
import { useMemo } from 'react'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAllWorktrees } from '@/store/selectors'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import { NEW_WORKSPACE_PROJECT_GROUP_OPTION_PREFIX } from '@/lib/new-workspace-project-options'

/** Use each project’s newest workspace creation as recency; it matches this picker’s action without separate persisted state. */
export function orderProjectIdsByRecency(
  worktrees: readonly Worktree[],
  repos: readonly Repo[] = [],
  settings?: ProjectGroupingSettings | null,
  grouping?: ProjectGroupingIndex
): string[] {
  const projectIndex = grouping ?? buildRepoProjectGroupingIndex(repos, settings)
  const newestByProject = new Map<string, number>()
  for (const worktree of worktrees) {
    const group = worktree.hostId
      ? projectIndex.groupByRepoHost.get(`${worktree.hostId}\0${worktree.repoId}`)
      : projectIndex.groupByRepoId.get(worktree.repoId)
    const projectId = group?.key ?? worktree.projectId
    if (projectId === undefined || projectId === '') {
      continue
    }
    const createdAt = worktree.createdAt ?? 0
    const seen = newestByProject.get(projectId)
    if (seen === undefined || createdAt > seen) {
      newestByProject.set(projectId, createdAt)
    }
  }
  return [...newestByProject.entries()]
    .sort((a, b) => b[1] - a[1])
    .flatMap(([projectId]) => [
      projectId,
      // Folder-group options carry a prefixed id, so both forms resolve.
      `${NEW_WORKSPACE_PROJECT_GROUP_OPTION_PREFIX}${projectId}`
    ])
}

export function useRecentProjectIds(): string[] {
  const worktrees = useAllWorktrees()
  const grouping = useAppStore(getProjectGroupingIndexFromState)
  return useMemo(
    () => orderProjectIdsByRecency(worktrees, [], undefined, grouping),
    [worktrees, grouping]
  )
}
