import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../../../../shared/constants'
import {
  computeClearFilterActions,
  sidebarHasActiveFilters,
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace,
  isSleepingSweepExemptWorkspace
} from '../../visible-worktrees'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  getWorktreeExecutionHostId,
  getSettingsFocusedExecutionHostId
} from '../../../../../../shared/execution-host'
import { isDefaultBranchWorkspace } from '../../default-branch-workspace'
import { getFolderWorkspaceExecutionHostIdForRows } from './host-filtering'
import {
  getPairedDeviceIdsByEnvironment,
  isWorkspaceFromOtherDevice
} from '../../workspace-creator-visibility'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { getWorktreeIdsWithLiveAgent, isInactiveWorkspace } from '@/lib/worktree-activity-state'
import {
  getVisibleWorktreeBrowserActivityTabs,
  getVisibleWorktreeTerminalActivityTabs
} from '../../visible-worktree-activity-inputs'

export type SidebarWorktreeFilters = ReturnType<typeof useSidebarWorktreeFilters>

// Every sidebar filter, plus the single escape hatch that resets all of them.
export function useSidebarWorktreeFilters() {
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore((s) => s.hideAutomationGeneratedWorkspaces)
  const hideCliCreatedWorkspaces = useAppStore((s) => s.hideCliCreatedWorkspaces)
  const hideDetachedHeadWorkspaces = useAppStore((s) => s.hideDetachedHeadWorkspaces)
  const hideWorkspacesFromOtherDevices = useAppStore((s) => s.hideWorkspacesFromOtherDevices)
  const alwaysShowDefaultBranchWorkspace = useAppStore((s) => s.alwaysShowDefaultBranchWorkspace)
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const workspaceHostScope = useAppStore((s) => s.workspaceHostScope)

  const setShowSleepingWorkspaces = useAppStore((s) => s.setShowSleepingWorkspaces)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const setHideAutomationGeneratedWorkspaces = useAppStore(
    (s) => s.setHideAutomationGeneratedWorkspaces
  )
  const setHideCliCreatedWorkspaces = useAppStore((s) => s.setHideCliCreatedWorkspaces)
  const setHideDetachedHeadWorkspaces = useAppStore((s) => s.setHideDetachedHeadWorkspaces)
  const setHideWorkspacesFromOtherDevices = useAppStore((s) => s.setHideWorkspacesFromOtherDevices)
  const setAlwaysShowDefaultBranchWorkspace = useAppStore(
    (s) => s.setAlwaysShowDefaultBranchWorkspace
  )
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const setVisibleWorkspaceHostIds = useAppStore((s) => s.setVisibleWorkspaceHostIds)

  const revealWorkspaceFilters = useCallback((worktree: Worktree) => {
    const state = useAppStore.getState()
    const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
    let targetHostId = getWorktreeExecutionHostId(
      worktree,
      repo,
      getSettingsFocusedExecutionHostId(state.settings)
    )
    const workspaceScope = parseWorkspaceKey(worktree.id)
    if (workspaceScope?.type === 'folder') {
      const folderWorkspace = state.folderWorkspaces.find(
        (candidate) => candidate.id === workspaceScope.folderWorkspaceId
      )
      const projectGroup = folderWorkspace
        ? state.projectGroups.find((candidate) => candidate.id === folderWorkspace.projectGroupId)
        : undefined
      if (folderWorkspace) {
        targetHostId = getFolderWorkspaceExecutionHostIdForRows({
          folderWorkspace,
          projectGroup,
          defaultHostId: getSettingsFocusedExecutionHostId(state.settings)
        })
      }
    }

    if (
      !worktree.id.startsWith('folder:') &&
      state.filterRepoIds.length > 0 &&
      !state.filterRepoIds.includes(worktree.repoId)
    ) {
      state.setFilterRepoIds([...state.filterRepoIds, worktree.repoId])
    }
    const visibleHostIds = state.visibleWorkspaceHostIds
    const scopedHostIds =
      visibleHostIds ?? (state.workspaceHostScope === 'all' ? null : [state.workspaceHostScope])
    if (scopedHostIds && !scopedHostIds.includes(targetHostId)) {
      state.setVisibleWorkspaceHostIds([...scopedHostIds, targetHostId])
    }
    if (state.hideDefaultBranchWorkspace && isDefaultBranchWorkspace(worktree)) {
      state.setHideDefaultBranchWorkspace(false)
    }
    if (state.hideAutomationGeneratedWorkspaces && isAutomationGeneratedWorkspace(worktree)) {
      state.setHideAutomationGeneratedWorkspaces(false)
    }
    if (state.hideCliCreatedWorkspaces && isCliCreatedWorkspace(worktree)) {
      state.setHideCliCreatedWorkspaces(false)
    }
    if (state.hideDetachedHeadWorkspaces && isDetachedHeadWorkspace(worktree)) {
      state.setHideDetachedHeadWorkspaces(false)
    }
    if (state.hideWorkspacesFromOtherDevices) {
      const pairedDeviceIds = getPairedDeviceIdsByEnvironment(
        state.runtimeEnvironments,
        state.runtimeStatusByEnvironmentId
      )
      if (isWorkspaceFromOtherDevice(worktree, pairedDeviceIds)) {
        state.setHideWorkspacesFromOtherDevices(false)
      }
    }
    if (!state.showSleepingWorkspaces) {
      const tabsByWorktree = getVisibleWorktreeTerminalActivityTabs(state.tabsByWorktree)
      const browserTabsByWorktree = getVisibleWorktreeBrowserActivityTabs(
        state.browserTabsByWorktree
      )
      const liveAgentWorktrees = getWorktreeIdsWithLiveAgent(
        state.agentStatusByPaneKey,
        tabsByWorktree,
        getAgentStatusEpochNow(state.agentStatusEpoch)
      )
      if (
        !isSleepingSweepExemptWorkspace(worktree, state.alwaysShowDefaultBranchWorkspace) &&
        isInactiveWorkspace(
          worktree.id,
          tabsByWorktree,
          state.ptyIdsByTabId,
          browserTabsByWorktree,
          liveAgentWorktrees
        )
      ) {
        state.setShowSleepingWorkspaces(true)
      }
    }
  }, [])

  // Why: count hideDefaultBranchWorkspace as a filter so the Clear Filters escape hatch stays reachable when it alone empties the list.
  const filterState = useMemo(
    () => ({
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
    }),
    [
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
    ]
  )

  const clearFilters = useCallback(() => {
    const actions = computeClearFilterActions(filterState)
    if (actions.resetShowSleepingWorkspaces) {
      setShowSleepingWorkspaces(DEFAULT_SHOW_SLEEPING_WORKSPACES)
    }
    if (actions.resetFilterRepoIds) {
      setFilterRepoIds([])
    }
    if (actions.resetHideDefaultBranchWorkspace) {
      setHideDefaultBranchWorkspace(false)
    }
    if (actions.resetHideAutomationGeneratedWorkspaces) {
      setHideAutomationGeneratedWorkspaces(false)
    }
    if (actions.resetHideCliCreatedWorkspaces) {
      setHideCliCreatedWorkspaces(false)
    }
    if (actions.resetHideDetachedHeadWorkspaces) {
      setHideDetachedHeadWorkspaces(false)
    }
    if (actions.resetHideWorkspacesFromOtherDevices) {
      setHideWorkspacesFromOtherDevices(false)
    }
    if (actions.resetAlwaysShowDefaultBranchWorkspace) {
      setAlwaysShowDefaultBranchWorkspace(true)
    }
    if (actions.resetVisibleWorkspaceHostIds) {
      setVisibleWorkspaceHostIds(null)
    }
  }, [
    setShowSleepingWorkspaces,
    setFilterRepoIds,
    setHideDefaultBranchWorkspace,
    setHideAutomationGeneratedWorkspaces,
    setHideCliCreatedWorkspaces,
    setHideDetachedHeadWorkspaces,
    setHideWorkspacesFromOtherDevices,
    setAlwaysShowDefaultBranchWorkspace,
    setVisibleWorkspaceHostIds,
    filterState
  ])

  return {
    filterState,
    hasFilters: sidebarHasActiveFilters(filterState),
    clearFilters,
    revealWorkspaceFilters
  }
}
