import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AgentDashboardMode } from '../../../../shared/ui-chrome-types'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'

/** A browser tab cannot open a second Orca window, so a web client only has the in-window board. */
export function canOpenAgentDashboardPopout(): boolean {
  return !isPairedWebClientWindow()
}

export function resolveAgentDashboardMode(
  settings: Pick<GlobalSettings, 'experimentalAgentDashboardMode'> | null | undefined
): AgentDashboardMode {
  return canOpenAgentDashboardPopout()
    ? (settings?.experimentalAgentDashboardMode ?? 'in-window')
    : 'in-window'
}
