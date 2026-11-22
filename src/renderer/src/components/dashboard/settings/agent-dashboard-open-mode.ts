import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type {
  ActiveRightSidebarTab,
  AgentDashboardMode
} from '../../../../../shared/ui-chrome/ui-chrome-types'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'

/** A browser tab cannot open a second Orca window, so a web client only has the in-window board. */
export function canOpenAgentDashboardPopout(): boolean {
  return !isPairedWebClientWindow()
}

export function resolveAgentDashboardMode(
  settings: Pick<GlobalSettings, 'experimentalAgentDashboardMode'> | null | undefined
): AgentDashboardMode {
  const mode = settings?.experimentalAgentDashboardMode ?? 'in-window'
  // Only the pop-out needs a second window; the right sidebar works in a web client too.
  return mode === 'popout' && !canOpenAgentDashboardPopout() ? 'in-window' : mode
}

type RightSidebarDockState = {
  rightSidebarOpen: boolean
  rightSidebarEffectiveTab: ActiveRightSidebarTab | null
  setRightSidebarOpen: (open: boolean) => void
  setRightSidebarTab: (tab: ActiveRightSidebarTab) => void
}

/** Close the docked board when it is showing; otherwise open the right sidebar on it. */
export function toggleAgentDashboardInRightSidebar(state: RightSidebarDockState): void {
  if (state.rightSidebarOpen && state.rightSidebarEffectiveTab === 'agent-dashboard') {
    state.setRightSidebarOpen(false)
    return
  }
  state.setRightSidebarTab('agent-dashboard')
  state.setRightSidebarOpen(true)
}

/** The board is a right sidebar tab only while the experiment is on and docked there. */
export function isAgentDashboardInRightSidebar(
  settings:
    | Pick<GlobalSettings, 'experimentalAgentDashboardPopout' | 'experimentalAgentDashboardMode'>
    | null
    | undefined
): boolean {
  return (
    settings?.experimentalAgentDashboardPopout === true &&
    resolveAgentDashboardMode(settings) === 'right-sidebar'
  )
}
