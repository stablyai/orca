import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import { resolveCommittedTitleAgentType } from '../../lib/pane-agent-evidence'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

type CtrlEnterPaneState = {
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry | undefined>
}

function agentAcceptsCtrlEnterCsiU(agent: PaneForegroundAgentEntry['agent']): boolean {
  return agent !== null && TUI_AGENT_CONFIG[agent].ctrlEnterEncoding === 'csi-u'
}

/** Resolves pane-scoped authority for query-only CSI-u consumers such as Droid and Grok. */
export function hasCtrlEnterCsiUAuthorityForPane(
  state: CtrlEnterPaneState,
  paneKey: string,
  terminalTitle?: string
): boolean {
  const foreground = state.paneForegroundAgentByPaneKey[paneKey]
  if (foreground?.shellForeground === true || foreground?.routingRevoked === true) {
    return false
  }
  if (foreground?.routingTrusted === true) {
    return agentAcceptsCtrlEnterCsiU(foreground.agent)
  }
  const titleAgent = terminalTitle ? resolveCommittedTitleAgentType(terminalTitle) : null
  if (foreground?.agent != null && foreground.agent !== titleAgent) {
    return false
  }
  return agentAcceptsCtrlEnterCsiU(titleAgent)
}
