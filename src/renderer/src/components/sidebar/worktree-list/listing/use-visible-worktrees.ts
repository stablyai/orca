import { selectSidebarLineageParentIdentities } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { shallow } from 'zustand/shallow'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import { getAgentStatusEpochNow } from '@/lib/agent-status/evidence/agent-status-epoch-clock'
import { createLiveAgentWorktreeIdsSelector } from '@/lib/workspace/activity/worktree-activity-state'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import './visible-worktrees'
import { computeVisibleWorktrees } from './compute-visible-worktrees'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  getPairedDeviceIdsByEnvironment
} from '../../../../../../shared/workspace-creator-visibility'
import {
  getVisibleWorktreeBrowserActivityTabs,
  getVisibleWorktreeTerminalActivityTabs,
  getStructuredChatWorktreeIds
} from './visible-worktree-activity-inputs'
import type { SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import type { SidebarWorktreeFilters } from './use-filters'
import { useReusedArrayIdentity } from './use-reused-array-identity'
import { useSleepingSweepRetention } from './use-sleeping-sweep-retention'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  readHiddenVmCheckouts,
  subscribeHiddenVmCheckouts,
  withoutHiddenVmWorktrees
} from '@/runtime/ephemeral-vm/vm-create-hidden-checkouts'

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
    hideSleepingProjectKeys,
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
  const filterSleeping = !showSleepingWorkspaces || (hideSleepingProjectKeys?.length ?? 0) > 0
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const agentStatusEpoch = useAppStore((s) => (filterSleeping ? s.agentStatusEpoch : 0))
  // Opt-out lists must skip the clock so they cannot evict the sample shared by live lists.
  const agentStatusNow = filterSleeping ? getAgentStatusEpochNow(agentStatusEpoch) : 0
  const selectPairedDevices = useMemo(
    () => createSidebarPairedDeviceIdsSelector(hideWorkspacesFromOtherDevices),
    [hideWorkspacesFromOtherDevices]
  )
  const pairedDeviceIdsByEnvironment = useAppStore(selectPairedDevices)
  const lineageParentIdentities = useAppStore(selectSidebarLineageParentIdentities)

  const needsActivityMaps = filterSleeping || sortBy === 'smart'
  const tabsByWorktree = useAppStore((s) =>
    needsActivityMaps ? getVisibleWorktreeTerminalActivityTabs(s.tabsByWorktree) : null
  )
  const ptyIdsByTabId = useAppStore((s) => (needsActivityMaps ? s.ptyIdsByTabId : null))
  const browserTabsByWorktree = useAppStore((s) =>
    filterSleeping ? getVisibleWorktreeBrowserActivityTabs(s.browserTabsByWorktree) : null
  )
  const worktreeIdsWithStructuredChat = useAppStore((s) =>
    getStructuredChatWorktreeIds(
      !filterSleeping,
      s.unifiedTabsByWorktree,
      s.structuredChatSleptAtByPaneKey
    )
  )

  // Recompute on epoch, not every hook ping; key on the epoch too since ticks can share a millisecond sample.
  const [selectLiveAgentWorktreeIds] = useState(createLiveAgentWorktreeIdsSelector)
  const worktreeIdsWithLiveAgent = useAppStore((s) =>
    filterSleeping
      ? selectLiveAgentWorktreeIds(s, tabsByWorktree, agentStatusNow)
      : EMPTY_WORKTREE_ID_SET
  )
  const sleepingSweepExemptWorktreeIds = useSleepingSweepRetention({
    enabled: filterSleeping,
    worktreesByRepo,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    worktreeIdsWithLiveAgent,
    worktreeIdsWithStructuredChat
  })

  const hiddenVmCheckouts = useSyncExternalStore(subscribeHiddenVmCheckouts, readHiddenVmCheckouts)
  const recomputedVisibleWorktrees = useMemo(() => {
    const visible = computeVisibleWorktrees(worktreesByRepo, sortedIds, {
      filterRepoIds,
      showSleepingWorkspaces,
      hideSleepingProjectKeys,
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
      lineageParentIdentities,
      preserveLineageParentOrder: sortBy === 'manual',
      // Both sorts rank by host identity (use-sort-order.ts).
      sortedByHostIdentity: true,
      forcedVisibleWorktreeIds: args.agentSendTargetWorktreeId
        ? [args.agentSendTargetWorktreeId]
        : undefined
    })
    return withoutHiddenVmWorktrees(visible, hiddenVmCheckouts)
  }, [
    hiddenVmCheckouts,
    args.agentSendTargetWorktreeId,
    worktreeIdsWithLiveAgent,
    sleepingSweepExemptWorktreeIds,
    filterRepoIds,
    showSleepingWorkspaces,
    hideSleepingProjectKeys,
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
    lineageParentIdentities,
    worktreesByRepo,
    pairedDeviceIdsByEnvironment,
    worktreeIdsWithStructuredChat
  ])
  // Reuse equal visibility results across epochs to avoid churning the entire row-model chain.
  const visibleWorktrees = useReusedArrayIdentity(recomputedVisibleWorktrees)

  return { visibleWorktrees, pairedDeviceIdsByEnvironment }
}
