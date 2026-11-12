import type { Worktree } from '../../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace
} from '../../../../../shared/worktree/workspace-kinds'
import { revealRepoInProjectFilter } from '@/components/sidebar/worktree-list/controls/project-filter-reveal'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { indexHiddenRepoRows } from '../../../../../shared/hidden-projects'
import { getWorktreeExecutionHostId } from '../../../../../shared/execution-host'

/** Hiding is no filter: opening such a workspace leaves the sidebar's filters and the project hidden. */
export function isWorktreeInHiddenProject(wt: Worktree): boolean {
  const { repos } = useAppStore.getState()
  // Route by the row's own host; unstamped rows and repos both read as this computer's.
  const hidden = indexHiddenRepoRows(repos)
  return (
    hidden.size > 0 &&
    hidden.has(wt.repoId, getWorktreeExecutionHostId(wt, getIndexedRepoMap(repos).get(wt.repoId)))
  )
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
