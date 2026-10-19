import type { AppState } from '@/store/types'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import { revealFloatingWorkspacePanel } from './floating-workspace-panel-reveal'
import { markVisited, readPreviousActive } from './worktree-activation-visit'

type FloatingPanelState = Pick<
  AppState,
  'settings' | 'updateSettings' | 'floatingWorkspacePanelOpen'
>

/**
 * Shows a workspace where it lives: the floating one in its panel (selecting it blanks the main window), others as the main selection and a visit.
 * @param createdTabIds tabs the caller just created into a requested group; activation would otherwise prune its empty groups.
 */
export function revealWorkspaceSurface(
  state: FloatingPanelState &
    Pick<
      AppState,
      | 'setActiveView'
      | 'setActiveWorktree'
      | 'markWorktreeVisited'
      | 'recordWorktreeVisit'
      | 'isNavigatingHistory'
      | 'revealWorktreeInSidebar'
      | 'activeWorktreeId'
      | 'activeWorkspaceExecutionHostId'
    >,
  worktreeId: string,
  createdTabIds?: readonly string[]
): void {
  if (isFloatingWorkspaceId(worktreeId)) {
    revealFloatingWorkspacePanel(state)
    return
  }
  const previousActive = readPreviousActive(state)
  state.setActiveView('terminal')
  if (createdTabIds) {
    state.setActiveWorktree(worktreeId, undefined, { createdTabIds })
  } else {
    state.setActiveWorktree(worktreeId)
  }
  markVisited(state, worktreeId, previousActive)
  if (!state.isNavigatingHistory) {
    state.recordWorktreeVisit(worktreeId)
  }
  state.revealWorktreeInSidebar(worktreeId)
}

/** Makes a workspace's surface current without a view switch, visit, history entry or sidebar scroll. */
export function selectWorkspaceSurface(
  state: FloatingPanelState & Pick<AppState, 'setActiveWorktree'>,
  worktreeId: string
): void {
  if (isFloatingWorkspaceId(worktreeId)) {
    revealFloatingWorkspacePanel(state)
    return
  }
  state.setActiveWorktree(worktreeId)
}
