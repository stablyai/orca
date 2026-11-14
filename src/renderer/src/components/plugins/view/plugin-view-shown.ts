import { canShowRightSidebarForView } from '@/components/right-sidebar/visibility/right-sidebar-visibility'
import type { AppState } from '@/store/types'

/** Why the panel is not on screen now, or null when it is the open right-sidebar tab or page. */
export function pluginPanelNotShownReason(
  state: Pick<
    AppState,
    | 'activeView'
    | 'activeWorktreeId'
    | 'rightSidebarOpen'
    | 'rightSidebarTab'
    | 'activePluginPageTabKey'
  >,
  tabKey: string,
  placement?: 'page'
): string | null {
  if (placement === 'page') {
    return state.activeView === 'plugin-page' && state.activePluginPageTabKey === tabKey
      ? null
      : 'Orca is not showing this plugin page'
  }
  if (!canShowRightSidebarForView(state.activeView) || !state.activeWorktreeId) {
    return 'Orca is not showing a workspace'
  }
  if (!state.rightSidebarOpen) {
    return 'the right sidebar is closed'
  }
  return state.rightSidebarTab === tabKey ? null : 'the right sidebar shows another tab'
}
