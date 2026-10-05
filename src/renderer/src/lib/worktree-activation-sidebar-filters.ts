import type { Worktree } from '../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { isDetachedHeadWorkspace } from '@/components/sidebar/visible-worktrees'
import { revealRepoInProjectFilter } from '@/components/sidebar/project-filter-reveal'

/** Lifts the workspace-list filters hiding an activated worktree; its reveal needs the card rendered, else it silently no-ops. */
export function liftSidebarFiltersHidingWorktree(wt: Worktree): void {
  const state = useAppStore.getState()
  // Not in the activity view: the reveal is skipped there, so lifting would only discard filters.
  if (state.sidebarBody === 'agents') {
    return
  }
  revealRepoInProjectFilter(state, wt.repoId)
  if (
    state.hideAutomationGeneratedWorkspaces &&
    wt.automationProvenance?.kind === 'created-by-automation'
  ) {
    state.setHideAutomationGeneratedWorkspaces(false)
  }
  if (state.hideCliCreatedWorkspaces && wt.cliProvenance?.kind === 'created-by-cli') {
    state.setHideCliCreatedWorkspaces(false)
  }
  if (state.hideDetachedHeadWorkspaces && isDetachedHeadWorkspace(wt)) {
    state.setHideDetachedHeadWorkspaces(false)
  }
}
