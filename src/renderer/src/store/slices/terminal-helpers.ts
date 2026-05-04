import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { detectAgentStatusFromTitle } from '@/lib/agent-status'

export function emptyLayoutSnapshot(): TerminalLayoutSnapshot {
  return {
    root: null,
    activeLeafId: null,
    expandedLeafId: null
  }
}

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
  // Why: reset any recognized agent title on hydration. The prior-session
  // agent is no longer running after a restart, so showing a stale
  // "Claude done" or spinner would be misleading.
  return detectAgentStatusFromTitle(tab.title) ? fallbackTitle : tab.title
}
