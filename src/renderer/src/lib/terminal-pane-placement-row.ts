import type { TerminalPaneNewTabRow } from '../../../shared/terminal-pane-placement'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

export function terminalPanePlacementRow(tab: TerminalTab): TerminalPaneNewTabRow {
  const {
    title,
    defaultTitle,
    customTitle,
    color,
    createdAt,
    startupCwd,
    shellOverride,
    quickCommandLabel,
    launchAgent,
    viewMode
  } = tab
  return {
    title,
    defaultTitle,
    customTitle,
    color,
    createdAt,
    startupCwd,
    shellOverride,
    quickCommandLabel,
    launchAgent,
    viewMode
  }
}
