import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../../shared/constants'
import { ALL_EXECUTION_HOSTS_SCOPE, type ExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import type { WorkspaceStatus } from '../../../../shared/types'

/** Inputs describing sidebar filter settings that the Clear Filters path owns. */
export type SidebarFilterState = {
  showSleepingWorkspaces: boolean
  filterRepoIds: readonly string[]
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hideWorkspacesFromOtherDevices: boolean
  /** Keeps each project's main workspace out of the "Hide sleeping" sweep; absent means on. */
  alwaysShowDefaultBranchWorkspace?: boolean
  /** Workspace statuses the user unchecked; absent/empty means every status shows. */
  hiddenWorkspaceStatusIds?: readonly WorkspaceStatus[]
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  workspaceHostScope?: ExecutionHostScope
}

/**
 * Whether at least one sidebar filter is active — drives the "Clear Filters"
 * escape hatch in the empty-state message. Kept pure so it can be unit-tested
 * alongside the sorting pipeline.
 *
 * Why include hideDefaultBranchWorkspace here: without it, a user whose only
 * worktree is the default-branch row and who toggles hide-on would see the
 * "No workspaces found" message with no in-sidebar recovery path.
 */
export function sidebarHasActiveFilters(state: SidebarFilterState): boolean {
  return (
    state.showSleepingWorkspaces !== DEFAULT_SHOW_SLEEPING_WORKSPACES ||
    state.filterRepoIds.length > 0 ||
    state.hideDefaultBranchWorkspace ||
    state.hideAutomationGeneratedWorkspaces ||
    state.hideCliCreatedWorkspaces ||
    state.hideDetachedHeadWorkspaces ||
    state.hideWorkspacesFromOtherDevices ||
    // Why: turning this off is the only way to narrow the list below the
    // default, so Clear Filters must be able to undo it like any other filter.
    state.alwaysShowDefaultBranchWorkspace === false ||
    (state.hiddenWorkspaceStatusIds?.length ?? 0) > 0 ||
    state.visibleWorkspaceHostIds != null ||
    (state.workspaceHostScope != null && state.workspaceHostScope !== ALL_EXECUTION_HOSTS_SCOPE)
  )
}

/** Describes which mutators the Clear Filters button must invoke, separated
 *  from the mutators themselves so the decision logic is testable. */
export type ClearFilterActions = {
  resetShowSleepingWorkspaces: boolean
  resetFilterRepoIds: boolean
  resetHideDefaultBranchWorkspace: boolean
  resetHideAutomationGeneratedWorkspaces: boolean
  resetHideCliCreatedWorkspaces: boolean
  resetHideDetachedHeadWorkspaces: boolean
  resetHideWorkspacesFromOtherDevices: boolean
  resetAlwaysShowDefaultBranchWorkspace: boolean
  resetHiddenWorkspaceStatusIds: boolean
  resetVisibleWorkspaceHostIds: boolean
}

/**
 * Determines which sidebar filters the Clear Filters button needs to reset.
 * Returning an explicit action plan (rather than just calling the setters)
 * keeps the pure decision separate from the impure mutations, so tests can
 * verify the logic without mounting the component.
 *
 * Why reset only the ones that are set: keeps Clear Filters from churning
 * UI state (and the debounced ui.set write-back) on every click when the
 * flag was already off.
 */
export function computeClearFilterActions(state: SidebarFilterState): ClearFilterActions {
  return {
    resetShowSleepingWorkspaces: state.showSleepingWorkspaces !== DEFAULT_SHOW_SLEEPING_WORKSPACES,
    resetFilterRepoIds: state.filterRepoIds.length > 0,
    resetHideDefaultBranchWorkspace: state.hideDefaultBranchWorkspace,
    resetHideAutomationGeneratedWorkspaces: state.hideAutomationGeneratedWorkspaces,
    resetHideCliCreatedWorkspaces: state.hideCliCreatedWorkspaces,
    resetHideDetachedHeadWorkspaces: state.hideDetachedHeadWorkspaces,
    resetHideWorkspacesFromOtherDevices: state.hideWorkspacesFromOtherDevices,
    resetAlwaysShowDefaultBranchWorkspace: state.alwaysShowDefaultBranchWorkspace === false,
    resetHiddenWorkspaceStatusIds: (state.hiddenWorkspaceStatusIds?.length ?? 0) > 0,
    resetVisibleWorkspaceHostIds:
      state.visibleWorkspaceHostIds != null ||
      (state.workspaceHostScope != null && state.workspaceHostScope !== ALL_EXECUTION_HOSTS_SCOPE)
  }
}
