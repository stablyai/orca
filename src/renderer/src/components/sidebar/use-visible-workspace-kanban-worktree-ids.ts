import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { Repo, Worktree } from '../../../../shared/types'
import { computeVisibleWorktreeIds } from './visible-worktrees'

type UseVisibleWorkspaceKanbanWorktreeIdsParams = {
  allWorktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
}

export function useVisibleWorkspaceKanbanWorktreeIds({
  allWorktrees,
  repoMap
}: UseVisibleWorkspaceKanbanWorktreeIdsParams): ReadonlySet<string> {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const sleptWorktreeIds = useAppStore((s) => s.sleptWorktreeIds)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)

  return useMemo(() => {
    // Why: the board has its own status ordering, but visibility must match
    // the sidebar filters exactly so hidden workspaces do not reappear here.
    const sortedIds = allWorktrees.map((worktree) => worktree.id)
    return new Set(
      computeVisibleWorktreeIds(worktreesByRepo, sortedIds, {
        filterRepoIds,
        showSleepingWorkspaces,
        sleptWorktreeIds,
        hideDefaultBranchWorkspace,
        repoMap,
        // Why: the board has no nested lineage presentation. Ancestor injection
        // would make filtered-out parents appear as ordinary cards.
        worktreeLineageById: {}
      })
    )
  }, [
    allWorktrees,
    filterRepoIds,
    hideDefaultBranchWorkspace,
    repoMap,
    showSleepingWorkspaces,
    sleptWorktreeIds,
    worktreesByRepo
  ])
}
