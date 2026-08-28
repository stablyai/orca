import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getWorktreeIdsWithLiveAgent } from '@/lib/worktree-activity-state'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { getSettingsFocusedExecutionHostId } from '../../../../../../shared/execution-host'
import { computeVisibleWorktrees } from '../../visible-worktrees'
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
    filterWorkspaceStatuses,
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
  // Why read the catalog only while a status filter is set: subscribing
  // unconditionally would rerun this pipeline on every status rename/recolor
  // for the majority of users who never filter by status.
  const workspaceStatuses = useAppStore((s) =>
    filterWorkspaceStatuses?.length ? s.workspaceStatuses : undefined
  )
  // Why pin the active workspace while a status filter is on: "Move to Status"
  // sits on the row itself, so restatusing the workspace you are working in
  // would otherwise delete its row while its panes stay open, with nothing on
  // screen explaining why. Status is the only filter dimension reachable from
  // the row, so no other filter can be turned against the row that turned it —
  // hence the gate rather than pinning the active row unconditionally.
  const activeWorktreeId = useAppStore((s) =>
    filterWorkspaceStatuses?.length ? s.activeWorktreeId : null
  )
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

  const recomputedVisibleWorktrees = useMemo(() => {
    void agentStatusEpoch
    // Either, both or neither may be set; stay undefined when neither is.
    const forcedVisibleWorktreeIds = [args.agentSendTargetWorktreeId, activeWorktreeId].filter(
      (id): id is string => id != null
    )
    return computeVisibleWorktrees(worktreesByRepo, sortedIds, {
      filterRepoIds,
      filterWorkspaceStatuses,
      workspaceStatuses,
      showSleepingWorkspaces,
      tabsByWorktree,
      ptyIdsByTabId,
      browserTabsByWorktree,
      // Why snapshot on agentStatusEpoch: update membership immediately without repainting on every hook ping.
      worktreeIdsWithLiveAgent: showSleepingWorkspaces
        ? EMPTY_WORKTREE_ID_SET
        : getWorktreeIdsWithLiveAgent(
            useAppStore.getState().agentStatusByPaneKey,
            tabsByWorktree,
            Date.now()
          ),
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
      forcedVisibleWorktreeIds:
        forcedVisibleWorktreeIds.length > 0 ? forcedVisibleWorktreeIds : undefined
    })
  }, [
    args.agentSendTargetWorktreeId,
    activeWorktreeId,
    agentStatusEpoch,
    filterRepoIds,
    filterWorkspaceStatuses,
    workspaceStatuses,
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
