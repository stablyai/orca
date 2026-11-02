import {
  activeWorkspaceRowFilterKeys,
  NO_WORKSPACE_ROW_FILTERS,
  type WorkspaceRowFilters
} from '../../../../shared/workspace-view/workspace-row-filters'
import { resolveVisibleWorkspaceHostIds } from '../../../../shared/workspace-view/workspace-host-visibility'
import type { AppState } from '../../store/types'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../shared/execution-host'

/**
 * Whether the sidebar is currently filtered, and what "clear filters" should undo.
 *
 * Split out of visible-worktrees to keep that file under the line cap; this is
 * about the filter CHROME, not about which rows survive filtering.
 */

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
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  workspaceHostScope?: ExecutionHostScope
}

/** The sidebar's store fields as the shared Workspace options filters. */
export function sidebarWorkspaceRowFilters(state: SidebarFilterState): WorkspaceRowFilters {
  return {
    hideSleepingWorkspaces: !state.showSleepingWorkspaces,
    alwaysShowDefaultBranchWorkspace: state.alwaysShowDefaultBranchWorkspace,
    hideDefaultBranchWorkspace: state.hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces: state.hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces: state.hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces: state.hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices: state.hideWorkspacesFromOtherDevices,
    filterRepoIds: state.filterRepoIds,
    visibleHostIds: resolveVisibleWorkspaceHostIds(
      state.visibleWorkspaceHostIds,
      state.workspaceHostScope
    )
  }
}

/** The store fields behind the sidebar filters, for a shallow-compared subscription. */
export function selectSidebarFilterState(
  state: AppState
): Pick<AppState, keyof SidebarFilterState> {
  return {
    showSleepingWorkspaces: state.showSleepingWorkspaces,
    filterRepoIds: state.filterRepoIds,
    hideDefaultBranchWorkspace: state.hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces: state.hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces: state.hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces: state.hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices: state.hideWorkspacesFromOtherDevices,
    alwaysShowDefaultBranchWorkspace: state.alwaysShowDefaultBranchWorkspace,
    visibleWorkspaceHostIds: state.visibleWorkspaceHostIds,
    workspaceHostScope: state.workspaceHostScope
  }
}

export function sidebarHasActiveFilters(state: SidebarFilterState): boolean {
  return activeWorkspaceRowFilterKeys(sidebarWorkspaceRowFilters(state)).length > 0
}

export type SidebarFilterSetters = Pick<
  AppState,
  | 'setShowSleepingWorkspaces'
  | 'setAlwaysShowDefaultBranchWorkspace'
  | 'setHideDefaultBranchWorkspace'
  | 'setHideAutomationGeneratedWorkspaces'
  | 'setHideCliCreatedWorkspaces'
  | 'setHideDetachedHeadWorkspaces'
  | 'setHideWorkspacesFromOtherDevices'
  | 'setFilterRepoIds'
  | 'setVisibleWorkspaceHostIds'
>

/** How each shared filter returns to its default; a new filter fails to compile until listed. */
const RESET_SIDEBAR_FILTER: Record<
  keyof WorkspaceRowFilters,
  (store: SidebarFilterSetters) => void
> = {
  hideSleepingWorkspaces: (store) =>
    store.setShowSleepingWorkspaces(!NO_WORKSPACE_ROW_FILTERS.hideSleepingWorkspaces),
  alwaysShowDefaultBranchWorkspace: (store) =>
    store.setAlwaysShowDefaultBranchWorkspace(
      NO_WORKSPACE_ROW_FILTERS.alwaysShowDefaultBranchWorkspace !== false
    ),
  hideDefaultBranchWorkspace: (store) =>
    store.setHideDefaultBranchWorkspace(NO_WORKSPACE_ROW_FILTERS.hideDefaultBranchWorkspace),
  hideAutomationGeneratedWorkspaces: (store) =>
    store.setHideAutomationGeneratedWorkspaces(
      NO_WORKSPACE_ROW_FILTERS.hideAutomationGeneratedWorkspaces
    ),
  hideCliCreatedWorkspaces: (store) =>
    store.setHideCliCreatedWorkspaces(NO_WORKSPACE_ROW_FILTERS.hideCliCreatedWorkspaces),
  hideDetachedHeadWorkspaces: (store) =>
    store.setHideDetachedHeadWorkspaces(NO_WORKSPACE_ROW_FILTERS.hideDetachedHeadWorkspaces),
  hideWorkspacesFromOtherDevices: (store) =>
    store.setHideWorkspacesFromOtherDevices(
      NO_WORKSPACE_ROW_FILTERS.hideWorkspacesFromOtherDevices
    ),
  filterRepoIds: (store) => store.setFilterRepoIds([...NO_WORKSPACE_ROW_FILTERS.filterRepoIds]),
  visibleHostIds: (store) => store.setVisibleWorkspaceHostIds(null)
}

/**
 * Clear filters: resets every active filter to its default, and only those, so a click with
 * nothing set issues no write.
 */
export function clearSidebarFilters(state: SidebarFilterState, store: SidebarFilterSetters): void {
  for (const key of activeWorkspaceRowFilterKeys(sidebarWorkspaceRowFilters(state))) {
    RESET_SIDEBAR_FILTER[key](store)
  }
}

/**
 * Shared pure utility that computes the ordered list of visible (non-archived,
 * non-filtered) worktree IDs. Both the App-level Cmd+1–9 handler and
 * WorktreeList's render pipeline consume this function so the numbering and
 * card order can never diverge.
 *
 * Why a shared function: if the filter/sort pipeline lived in two places, a
 * new filter added in one but not the other would silently break the mapping
 * between badge numbers and the Cmd+N shortcut target.
 */
