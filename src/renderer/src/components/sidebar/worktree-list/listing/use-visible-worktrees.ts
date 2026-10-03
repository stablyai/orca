import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import {
  getWorktreeIdsWithLiveAgent,
  hasActiveWorkspaceActivity
} from '@/lib/worktree-activity-state'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { computeVisibleWorktrees } from '../../visible-worktrees'
import {
  createSleepingSweepRetentionState,
  updateSleepingSweepRetention
} from '../../sleeping-sweep-retention'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  getPairedDeviceIdsByEnvironment
} from '../../workspace-creator-visibility'
import {
  getVisibleWorktreeBrowserActivityTabs,
  getVisibleWorktreeTerminalActivityTabs,
  getStructuredChatWorktreeIds
} from '../../visible-worktree-activity-inputs'
import type { SortBy } from '../../smart-sort'
import type { SidebarWorktreeFilters } from './use-filters'
import { useReusedArrayIdentity } from './use-reused-array-identity'

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
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
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
    getStructuredChatWorktreeIds(showSleepingWorkspaces, s.unifiedTabsByWorktree)
  )

  const retentionStateRef = useRef(createSleepingSweepRetentionState())
  const [sweepGraceTick, setSweepGraceTick] = useState(0)

  // Why snapshot on agentStatusEpoch: update membership immediately without repainting on every hook ping.
  const sweepInputs = useMemo(() => {
    // Keyed on the epoch, not `agentStatusNow`: two bumps in one millisecond
    // share a sample, so the timestamp alone would not re-key this memo.
    void agentStatusEpoch
    void sweepGraceTick
    if (showSleepingWorkspaces) {
      retentionStateRef.current = createSleepingSweepRetentionState()
      return {
        worktreeIdsWithLiveAgent: EMPTY_WORKTREE_ID_SET,
        sleepingSweepExemptWorktreeIds: undefined,
        nextExpiryInMs: null
      }
    }
    const worktreeIdsWithLiveAgent = getWorktreeIdsWithLiveAgent(
      useAppStore.getState().agentStatusByPaneKey,
      tabsByWorktree,
      agentStatusNow
    )
    // Why: a PTY rebind empties ptyIdsByTabId for a commit, which would sweep an
    // open remote workspace out and back in one frame (#15996).
    const { retainedIds, nextExpiryInMs } = updateSleepingSweepRetention({
      state: retentionStateRef.current,
      candidateWorktreeIds: sortedIds,
      isActive: (worktreeId) =>
        hasActiveWorkspaceActivity(
          worktreeId,
          tabsByWorktree,
          ptyIdsByTabId,
          browserTabsByWorktree,
          worktreeIdsWithLiveAgent,
          worktreeIdsWithStructuredChat
        ),
      // oxlint-disable-next-line react/purity -- Grace windows need wall time; the epoch sample stalls between bumps.
      nowMs: Date.now()
    })
    return {
      worktreeIdsWithLiveAgent,
      sleepingSweepExemptWorktreeIds: retainedIds,
      nextExpiryInMs
    }
  }, [
    agentStatusEpoch,
    agentStatusNow,
    sweepGraceTick,
    showSleepingWorkspaces,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    worktreeIdsWithStructuredChat,
    sortedIds
  ])

  // Why: without a wake the last grace window would hold its row until some
  // unrelated store change happened to recompute the sweep.
  const { nextExpiryInMs } = sweepInputs
  useEffect(() => {
    if (nextExpiryInMs === null) {
      return
    }
    const timer = setTimeout(() => setSweepGraceTick((tick) => tick + 1), nextExpiryInMs)
    return () => clearTimeout(timer)
  }, [nextExpiryInMs])

  const recomputedVisibleWorktrees = useMemo(() => {
    return computeVisibleWorktrees(worktreesByRepo, sortedIds, {
      filterRepoIds,
      showSleepingWorkspaces,
      tabsByWorktree,
      ptyIdsByTabId,
      browserTabsByWorktree,
      worktreeIdsWithStructuredChat,
      worktreeIdsWithLiveAgent: sweepInputs.worktreeIdsWithLiveAgent,
      sleepingSweepExemptWorktreeIds: sweepInputs.sleepingSweepExemptWorktreeIds,
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
      forcedVisibleWorktreeIds: args.agentSendTargetWorktreeId
        ? [args.agentSendTargetWorktreeId]
        : undefined
    })
  }, [
    args.agentSendTargetWorktreeId,
    sweepInputs,
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
