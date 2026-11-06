import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import type { AppState } from '@/store/types'

/** Why the panel is not on screen now, or null when it is the open right-sidebar tab. */
export function pluginPanelNotShownReason(
  state: Pick<AppState, 'activeView' | 'activeWorktreeId' | 'rightSidebarOpen' | 'rightSidebarTab'>,
  tabKey: string
): string | null {
  if (!canShowRightSidebarForView(state.activeView) || !state.activeWorktreeId) {
    return 'Orca is not showing a workspace'
  }
  if (!state.rightSidebarOpen) {
    return 'the right sidebar is closed'
  }
  return state.rightSidebarTab === tabKey ? null : 'the right sidebar shows another tab'
}
