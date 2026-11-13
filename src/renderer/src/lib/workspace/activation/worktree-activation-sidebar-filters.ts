import type { Worktree } from '../../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace
} from '../../../../../shared/worktree/visibility/workspace-kinds'
import { revealRepoInProjectFilter } from '@/components/sidebar/worktree-list/controls/project-filter-reveal'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { buildVisibleWorktreeOptionsFromState } from '@/components/sidebar/worktree-list/listing/visible-worktree-options-from-state'

/** Hiding is no filter: opening such a workspace leaves the sidebar's filters and the project hidden. */
export function isWorktreeInHiddenProject(wt: Pick<Worktree, 'repoId' | 'hostId'>): boolean {
  const state = useAppStore.getState()
  // The sidebar's own hidden-project check, with its default host, so both agree on unstamped rows.
  return buildVisibleWorktreeOptionsFromState(
    state,
    getIndexedRepoMap(state.repos)
  ).hiddenProjects.isRowHidden(wt)
}

/** Lifts the workspace-list filters hiding an activated worktree; its reveal needs the card rendered, else it silently no-ops. */
export function liftSidebarFiltersHidingWorktree(wt: Worktree): void {
  const state = useAppStore.getState()
  // Not in the activity view: the reveal is skipped there, so lifting would only discard filters.
  if (state.sidebarBody === 'agents') {
    return
  }
  revealRepoInProjectFilter(state, wt.repoId)
  if (state.hideAutomationGeneratedWorkspaces && isAutomationGeneratedWorkspace(wt)) {
    state.setHideAutomationGeneratedWorkspaces(false)
  }
  if (state.hideCliCreatedWorkspaces && isCliCreatedWorkspace(wt)) {
    state.setHideCliCreatedWorkspaces(false)
  }
  if (state.hideDetachedHeadWorkspaces && isDetachedHeadWorkspace(wt)) {
    state.setHideDetachedHeadWorkspaces(false)
  }
}
