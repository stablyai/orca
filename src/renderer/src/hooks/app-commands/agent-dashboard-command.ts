import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { AppState } from '../../store/types'
import {
  resolveAgentDashboardMode,
  toggleAgentDashboardInRightSidebar
} from '../../components/dashboard/settings/agent-dashboard-open-mode'
import { showWorkspaceListThen } from '../../components/app-rail/app-rail-navigation'
import { useAppStore } from '../../store/index'

export function toggleAgentDashboardFromShortcut(
  state: Pick<
    AppState,
    | 'activeView'
    | 'agentDashboardDrawerOpen'
    | 'setSidebarOpen'
    | 'setAgentDashboardDrawerOpen'
    | 'rightSidebarOpen'
    | 'rightSidebarEffectiveTab'
    | 'setRightSidebarOpen'
    | 'setRightSidebarTab'
  > & {
    settings: Pick<
      GlobalSettings,
      'experimentalAgentDashboardPopout' | 'experimentalAgentDashboardMode'
    > | null
  },
  openPopout: () => void
): void {
  if (
    state.activeView === 'settings' ||
    state.settings?.experimentalAgentDashboardPopout !== true
  ) {
    return
  }
  const mode = resolveAgentDashboardMode(state.settings)
  if (mode === 'popout') {
    openPopout()
    return
  }
  if (mode === 'right-sidebar') {
    toggleAgentDashboardInRightSidebar(state)
    return
  }
  const nextOpen = !state.agentDashboardDrawerOpen
  // A rail page has no list to dock the drawer beside: go to Workspaces with the list showing, then open it.
  if (
    nextOpen &&
    showWorkspaceListThen(useAppStore, () => state.setAgentDashboardDrawerOpen(true))
  ) {
    return
  }
  // The drawer self-closes with the sidebar: reveal only when opening, never while closing.
  if (nextOpen) {
    state.setSidebarOpen(true)
  }
  state.setAgentDashboardDrawerOpen(nextOpen)
}
