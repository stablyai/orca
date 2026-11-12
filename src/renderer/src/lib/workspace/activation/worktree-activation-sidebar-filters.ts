import type { Worktree } from '../../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace
} from '../../../../../shared/worktree/workspace-kinds'
import { revealRepoInProjectFilter } from '@/components/sidebar/worktree-list/controls/project-filter-reveal'
import { indexHiddenProjects } from '../../../../../shared/hidden-projects'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'

/** Hiding is no filter: opening such a workspace leaves the sidebar's filters and the project hidden. */
export function isWorktreeInHiddenProject(wt: Pick<Worktree, 'repoId' | 'hostId'>): boolean {
  // A row with no stamp is this window's own (repo-update.ts), so local is its default host.
  return indexHiddenProjects(useAppStore.getState().repos, LOCAL_EXECUTION_HOST_ID).isRowHidden(wt)
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
