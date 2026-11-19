import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { detectAgentStatusFromTitle } from '../../../../../shared/agent-status/title/agent-title-status'

export function clearTransientTerminalState(tab: TerminalTab, index: number): TerminalTab {
  return {
    ...tab,
    ptyId: null,
    title: getResetTitle(tab, index)
  }
}

function getResetTitle(tab: TerminalTab, index: number): string {
  const fallbackTitle =
    tab.customTitle?.trim() || tab.defaultTitle?.trim() || `Terminal ${index + 1}`
  // After restart, prior-session done/spinner titles would falsely imply a running agent.
  return detectAgentStatusFromTitle(tab.title) ? fallbackTitle : tab.title
}
