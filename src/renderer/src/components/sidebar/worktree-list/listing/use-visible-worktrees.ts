import { useMemo } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'
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

// Applies every sidebar filter to the sorted id stream. Flatten/filter/sort goes through the
// shared utility so card order matches Cmd+1–9 numbering.
export function useVisibleSidebarWorktrees(args: {
  filterState: SidebarWorktreeFilters['filterState']
  sortBy: SortBy
  sortedIds: string[]
  repoMap: Map<string, Repo>
  worktreeLineageById: Record<string, WorktreeLineage>
  /** Pre-derived focused host; the whole `settings` object would re-key this
   *  423-workspace scan on every unrelated settings write. */
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
  // Why: skip the clock entirely when the epoch is the opt-out sentinel, so a
  // sleeping-workspaces list cannot evict the sample the live lists share.
  const agentStatusNow = showSleepingWorkspaces ? 0 : getAgentStatusEpochNow(agentStatusEpoch)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const pairedDeviceIdsByEnvironment = useMemo(
    () =>
      hideWorkspacesFromOtherDevices
        ? getPairedDeviceIdsByEnvironment(runtimeEnvironments, runtimeStatusByEnvironmentId)
        : EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
    [hideWorkspacesFromOtherDevices, runtimeEnvironments, runtimeStatusByEnvironmentId]
  )

  // Read tabsByWorktree when needed for filtering or sorting
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
    // Keyed on the epoch, not `agentStatusNow`: two bumps in one millisecond
    // share a sample, so the timestamp alone would not re-key this memo.
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
      // Switch point: the stamp sort ranks by host identity (use-sort-order.ts).
      sortedByHostIdentity: ORCA_SIDEBAR_INPUTS_IS_MAIN,
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
  // Why: agentStatusEpoch bumps recompute this memo even when membership and
  // order are unchanged; keeping the previous identity stops the whole
  // rows/sectionRows/renderedWorktrees chain from churning per epoch.
  const visibleWorktrees = useReusedArrayIdentity(recomputedVisibleWorktrees)

  return { visibleWorktrees, pairedDeviceIdsByEnvironment }
}
