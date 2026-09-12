import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../../../../shared/constants'
import { computeClearFilterActions, sidebarHasActiveFilters } from '../../visible-worktrees'

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
  const setFocusedProjectGroupId = useAppStore((s) => s.setFocusedProjectGroupId)
  const focusedProjectGroupId = useAppStore((s) => s.focusedProjectGroupId)

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
      workspaceHostScope,
      focusedProjectGroupId
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
      workspaceHostScope,
      focusedProjectGroupId
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
    if (actions.resetFocusedProjectGroupId) {
      setFocusedProjectGroupId(null)
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
    setFocusedProjectGroupId,
    filterState
  ])

  return { filterState, hasFilters: sidebarHasActiveFilters(filterState), clearFilters }
}
