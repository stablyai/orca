import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { Repo, Worktree } from '../../../../shared/types'
import { computeVisibleWorktreeIds } from './visible-worktrees'
import { getWorktreeIdsWithLiveAgent } from '@/lib/worktree-activity-state'
import { getSettingsFocusedExecutionHostId } from '../../../../shared/execution-host'

type UseVisibleWorkspaceKanbanWorktreeIdsParams = {
  allWorktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
}

const EMPTY_WORKTREE_ID_SET: ReadonlySet<string> = new Set()

export function useVisibleWorkspaceKanbanWorktreeIds({
  allWorktrees,
  repoMap
}: UseVisibleWorkspaceKanbanWorktreeIdsParams): ReadonlySet<string> {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore((s) => s.hideAutomationGeneratedWorkspaces)
  const workspaceHostScope = useAppStore((s) => s.workspaceHostScope)
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const settings = useAppStore((s) => s.settings)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const tabsByWorktree = useAppStore((s) => (!showSleepingWorkspaces ? s.tabsByWorktree : null))
  const ptyIdsByTabId = useAppStore((s) => (!showSleepingWorkspaces ? s.ptyIdsByTabId : null))
  const browserTabsByWorktree = useAppStore((s) =>
    !showSleepingWorkspaces ? s.browserTabsByWorktree : null
  )
  const agentStatusEpoch = useAppStore((s) => (!showSleepingWorkspaces ? s.agentStatusEpoch : 0))
  // Why snapshot on the epoch: the always-mounted drawer must not scan every
  // agent on unrelated store writes; membership changes advance this tick.
  const worktreeIdsWithLiveAgent = useMemo(() => {
    void agentStatusEpoch
    return !showSleepingWorkspaces
      ? getWorktreeIdsWithLiveAgent(
          useAppStore.getState().agentStatusByPaneKey,
          tabsByWorktree,
          Date.now()
        )
      : EMPTY_WORKTREE_ID_SET
  }, [agentStatusEpoch, showSleepingWorkspaces, tabsByWorktree])

  return useMemo(() => {
    // Why: the board has its own status ordering, but visibility must match
    // the sidebar filters exactly so hidden workspaces do not reappear here.
    const sortedIds = allWorktrees.map((worktree) => worktree.id)
    return new Set(
      computeVisibleWorktreeIds(worktreesByRepo, sortedIds, {
        filterRepoIds,
        showSleepingWorkspaces,
        tabsByWorktree,
        ptyIdsByTabId,
        browserTabsByWorktree,
        worktreeIdsWithLiveAgent,
        hideDefaultBranchWorkspace,
        hideAutomationGeneratedWorkspaces,
        repoMap,
        workspaceHostScope,
        visibleWorkspaceHostIds,
        defaultHostId: getSettingsFocusedExecutionHostId(settings),
        // Why: the board has no nested lineage presentation. Ancestor injection
        // would make filtered-out parents appear as ordinary cards.
        worktreeLineageById: {}
      })
    )
  }, [
    allWorktrees,
    browserTabsByWorktree,
    filterRepoIds,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    workspaceHostScope,
    visibleWorkspaceHostIds,
    settings,
    ptyIdsByTabId,
    repoMap,
    showSleepingWorkspaces,
    tabsByWorktree,
    worktreeIdsWithLiveAgent,
    worktreesByRepo
  ])
}
