import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { Repo, Worktree } from '../../../../shared/types'
import { computeVisibleWorktreeIds } from './visible-worktrees'

type UseVisibleWorkspaceKanbanWorktreeIdsParams = {
  allWorktrees: readonly Worktree[]
  activeWorktreeId: string | null
  repoMap: Map<string, Repo>
}

export function useVisibleWorkspaceKanbanWorktreeIds({
  allWorktrees,
  activeWorktreeId,
  repoMap
}: UseVisibleWorkspaceKanbanWorktreeIdsParams): ReadonlySet<string> {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const tabsByWorktree = useAppStore((s) => (showActiveOnly ? s.tabsByWorktree : null))
  const ptyIdsByTabId = useAppStore((s) => (showActiveOnly ? s.ptyIdsByTabId : null))
  const browserTabsByWorktree = useAppStore((s) =>
    showActiveOnly ? s.browserTabsByWorktree : null
  )

  return useMemo(() => {
    // Why: the board has its own status ordering, but visibility must match
    // the sidebar filters exactly so hidden workspaces do not reappear here.
    const sortedIds = allWorktrees.map((worktree) => worktree.id)
    return new Set(
      computeVisibleWorktreeIds(worktreesByRepo, sortedIds, {
        filterRepoIds,
        showActiveOnly,
        tabsByWorktree,
        ptyIdsByTabId,
        browserTabsByWorktree,
        activeWorktreeId,
        hideDefaultBranchWorkspace,
        repoMap
      })
    )
  }, [
    activeWorktreeId,
    allWorktrees,
    browserTabsByWorktree,
    filterRepoIds,
    hideDefaultBranchWorkspace,
    ptyIdsByTabId,
    repoMap,
    showActiveOnly,
    tabsByWorktree,
    worktreesByRepo
  ])
}
