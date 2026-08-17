import { useMemo } from 'react'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAllWorktrees } from '@/store/selectors'
import { NEW_WORKSPACE_PROJECT_GROUP_OPTION_PREFIX } from '@/lib/new-workspace-project-options'

/**
 * Most-recently-used project option ids, newest first, derived from when the
 * user last created a workspace in each project. Orca stores no explicit
 * per-project recency, and workspace creation is exactly the action this picker
 * is about to repeat, so it's the honest proxy rather than a new store field.
 */
export function orderProjectIdsByRecency(worktrees: readonly Worktree[]): string[] {
  const newestByProject = new Map<string, number>()
  for (const worktree of worktrees) {
    const projectId = worktree.projectId
    // Legacy repo-only workspaces have no projectId and can't be attributed.
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
  return useMemo(() => orderProjectIdsByRecency(worktrees), [worktrees])
}
