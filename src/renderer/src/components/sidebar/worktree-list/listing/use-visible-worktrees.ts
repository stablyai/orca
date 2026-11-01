import { useMemo } from 'react'
import { shallow } from 'zustand/shallow'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { getWorktreeIdsWithLiveAgent } from '@/lib/worktree-activity-state'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { computeVisibleWorktrees } from '../../visible-worktrees'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  getPairedDeviceIdsByEnvironment
} from '../../../../../../shared/workspace-creator-visibility'
import {
  getVisibleWorktreeBrowserActivityTabs,
  getVisibleWorktreeTerminalActivityTabs,
  getStructuredChatWorktreeIds
} from '../../visible-worktree-activity-inputs'
import type { SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import type { SidebarWorktreeFilters } from './use-filters'
import { useReusedArrayIdentity } from './use-reused-array-identity'
import { useSleepingSweepRetention } from './use-sleeping-sweep-retention'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

const EMPTY_WORKTREE_ID_SET: ReadonlySet<string> = new Set()

function createSidebarPairedDeviceIdsSelector(enabled: boolean) {
  let inputs: readonly unknown[] = []
  let result = EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT
  return (state: AppState): ReadonlyMap<string, string> => {
    if (!enabled) {
      return EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT
    }
    const nextInputs = [state.runtimeEnvironments, state.runtimeStatusByEnvironmentId]
    if (shallow(inputs, nextInputs)) {
      return result
    }
    inputs = nextInputs
    const next = getPairedDeviceIdsByEnvironment(
      state.runtimeEnvironments,
      state.runtimeStatusByEnvironmentId
    )
    if (!shallow(result, next)) {
      result = next
    }
    return result
  }
}

// Share visibility filtering with shortcuts so displayed order and Cmd+1–9 numbering agree.
export function useVisibleSidebarWorktrees(args: {
  filterState: SidebarWorktreeFilters['filterState']
  sortBy: SortBy
  sortedIds: string[]
  repoMap: Map<string, Repo>
  worktreeLineageById: Record<string, WorktreeLineage>
  /** Pass only focused host so unrelated settings writes cannot invalidate the full workspace scan. */
  defaultHostId: ExecutionHostId
  agentSendTargetWorktreeId: string | null
}) {
  const { filterState, sortBy, sortedIds, repoMap, worktreeLineageById, defaultHostId } = args
  const {
    showSleepingWorkspaces,
    filterRepoIds,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices,
    alwaysShowDefaultBranchWorkspace,
    visibleWorkspaceHostIds,
    workspaceHostScope
  } = filterState
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const agentStatusEpoch = useAppStore((s) => (!showSleepingWorkspaces ? s.agentStatusEpoch : 0))
  // Opt-out lists must skip the clock so they cannot evict the sample shared by live lists.
  const agentStatusNow = showSleepingWorkspaces ? 0 : getAgentStatusEpochNow(agentStatusEpoch)
  const selectPairedDevices = useMemo(
    () => createSidebarPairedDeviceIdsSelector(hideWorkspacesFromOtherDevices),
    [hideWorkspacesFromOtherDevices]
  )
  const pairedDeviceIdsByEnvironment = useAppStore(selectPairedDevices)

  const needsActivityMaps = !showSleepingWorkspaces || sortBy === 'smart'
  const tabsByWorktree = useAppStore((s) =>
    needsActivityMaps ? getVisibleWorktreeTerminalActivityTabs(s.tabsByWorktree) : null
  )
  const ptyIdsByTabId = useAppStore((s) => (needsActivityMaps ? s.ptyIdsByTabId : null))
  const browserTabsByWorktree = useAppStore((s) =>
    !showSleepingWorkspaces ? getVisibleWorktreeBrowserActivityTabs(s.browserTabsByWorktree) : null
  )
  const worktreeIdsWithStructuredChat = useAppStore((s) =>
    getStructuredChatWorktreeIds(
      showSleepingWorkspaces,
      s.unifiedTabsByWorktree,
      s.structuredChatSleptAtByPaneKey
    )
  )

  // Why snapshot on agentStatusEpoch: update membership immediately without repainting on every hook ping.
  const worktreeIdsWithLiveAgent = useMemo(() => {
    // Epochs can share a millisecond sample; key on the epoch itself so membership still refreshes.
    void agentStatusEpoch
    return showSleepingWorkspaces
      ? EMPTY_WORKTREE_ID_SET
      : getWorktreeIdsWithLiveAgent(
          useAppStore.getState().agentStatusByPaneKey,
          tabsByWorktree,
          agentStatusNow
        )
  }, [agentStatusEpoch, agentStatusNow, showSleepingWorkspaces, tabsByWorktree])
  const sleepingSweepExemptWorktreeIds = useSleepingSweepRetention({
    enabled: !showSleepingWorkspaces,
    worktreesByRepo,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    worktreeIdsWithLiveAgent,
    worktreeIdsWithStructuredChat
  })

  const recomputedVisibleWorktrees = useMemo(() => {
    return computeVisibleWorktrees(worktreesByRepo, sortedIds, {
      filterRepoIds,
      showSleepingWorkspaces,
      tabsByWorktree,
      ptyIdsByTabId,
      browserTabsByWorktree,
      worktreeIdsWithStructuredChat,
      worktreeIdsWithLiveAgent,
      sleepingSweepExemptWorktreeIds,
      hideDefaultBranchWorkspace,
      hideAutomationGeneratedWorkspaces,
      hideCliCreatedWorkspaces,
      hideDetachedHeadWorkspaces,
      hideWorkspacesFromOtherDevices,
      pairedDeviceIdsByEnvironment,
      alwaysShowDefaultBranchWorkspace,
      repoMap,
      workspaceHostScope,
      visibleWorkspaceHostIds,
      defaultHostId,
      worktreeLineageById,
      preserveLineageParentOrder: sortBy === 'manual',
      // Both sorts rank by host identity (use-sort-order.ts).
      sortedByHostIdentity: true,
      forcedVisibleWorktreeIds: args.agentSendTargetWorktreeId
        ? [args.agentSendTargetWorktreeId]
        : undefined
    })
  }, [
    args.agentSendTargetWorktreeId,
    worktreeIdsWithLiveAgent,
    sleepingSweepExemptWorktreeIds,
    filterRepoIds,
    showSleepingWorkspaces,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices,
    alwaysShowDefaultBranchWorkspace,
    workspaceHostScope,
    visibleWorkspaceHostIds,
    defaultHostId,
    repoMap,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    sortedIds,
    sortBy,
    worktreeLineageById,
    worktreesByRepo,
    pairedDeviceIdsByEnvironment,
    worktreeIdsWithStructuredChat
  ])
  // Reuse equal visibility results across epochs to avoid churning the entire row-model chain.
  const visibleWorktrees = useReusedArrayIdentity(recomputedVisibleWorktrees)

  return { visibleWorktrees, pairedDeviceIdsByEnvironment }
}
