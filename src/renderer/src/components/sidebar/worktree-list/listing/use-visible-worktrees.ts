import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  getWorktreeIdsWithLiveAgent,
  hasActiveWorkspaceActivity
} from '@/lib/worktree-activity-state'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { getSettingsFocusedExecutionHostId } from '../../../../../../shared/execution-host'
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
  getVisibleWorktreeTerminalActivityTabs
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
  settings: AppState['settings']
  agentSendTargetWorktreeId: string | null
}) {
  const { filterState, sortBy, sortedIds, repoMap, worktreeLineageById, settings } = args
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

  const retentionStateRef = useRef(createSleepingSweepRetentionState())
  const [sweepGraceTick, setSweepGraceTick] = useState(0)

  // Why snapshot on agentStatusEpoch: update membership immediately without repainting on every hook ping.
  const sweepInputs = useMemo(() => {
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
    const nowMs = Date.now()
    const worktreeIdsWithLiveAgent = getWorktreeIdsWithLiveAgent(
      useAppStore.getState().agentStatusByPaneKey,
      tabsByWorktree,
      nowMs
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
          worktreeIdsWithLiveAgent
        ),
      nowMs
    })
    return {
      worktreeIdsWithLiveAgent,
      sleepingSweepExemptWorktreeIds: retainedIds,
      nextExpiryInMs
    }
  }, [
    agentStatusEpoch,
    sweepGraceTick,
    showSleepingWorkspaces,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
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
      defaultHostId: getSettingsFocusedExecutionHostId(settings),
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
    settings,
    repoMap,
    tabsByWorktree,
    ptyIdsByTabId,
    browserTabsByWorktree,
    sortedIds,
    worktreeLineageById,
    worktreesByRepo,
    pairedDeviceIdsByEnvironment
  ])
  // Why: agentStatusEpoch bumps recompute this memo even when membership and
  // order are unchanged; keeping the previous identity stops the whole
  // rows/sectionRows/renderedWorktrees chain from churning per epoch.
  const visibleWorktrees = useReusedArrayIdentity(recomputedVisibleWorktrees)

  return { visibleWorktrees, pairedDeviceIdsByEnvironment }
}
