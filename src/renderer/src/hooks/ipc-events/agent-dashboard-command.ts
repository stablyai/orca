import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AppState } from '../../store/types'
import { resolveAgentDashboardMode } from '../../components/dashboard/agent-dashboard-open-mode'

export function toggleAgentDashboardFromShortcut(
  state: Pick<
    AppState,
    'activeView' | 'agentDashboardDrawerOpen' | 'setSidebarOpen' | 'setAgentDashboardDrawerOpen'
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
  if (resolveAgentDashboardMode(state.settings) === 'popout') {
    openPopout()
    return
  }
  const nextOpen = !state.agentDashboardDrawerOpen
  // The drawer self-closes with the sidebar: reveal only when opening, never while closing.
  if (nextOpen) {
    state.setSidebarOpen(true)
  }
  state.setAgentDashboardDrawerOpen(nextOpen)
}
