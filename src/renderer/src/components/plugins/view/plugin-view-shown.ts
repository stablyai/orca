import { canShowRightSidebarForView } from '@/components/right-sidebar/visibility/right-sidebar-visibility'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'
import type { AppState } from '@/store/types'

/** Why the panel is not on screen now, or null when it is the open right-sidebar tab. */
export function pluginPanelNotShownReason(
  state: Pick<
    AppState,
    | 'activeView'
    | 'activeWorktreeId'
    | 'activePendingCreationId'
    | 'pendingWorktreeCreations'
    | 'rightSidebarOpen'
    | 'rightSidebarTab'
    | 'rightSidebarEffectiveTab'
  >,
  tabKey: string
): string | null {
  if (
    !canShowRightSidebarForView(state.activeView) ||
    !state.activeWorktreeId ||
    selectWorktreeCreationSurfaceShown(state)
  ) {
    return 'Orca is not showing a workspace'
  }
  if (!state.rightSidebarOpen) {
    return 'the right sidebar is closed'
  }
  const shownTab = state.rightSidebarEffectiveTab ?? state.rightSidebarTab
  return shownTab === tabKey ? null : 'the right sidebar shows another tab'
}
