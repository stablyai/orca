import { isBuiltInTuiAgent, TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import { resolveCommittedTitleAgentType } from '../../lib/pane-agent-evidence'
import { resolvePaneOwnerBaseAgent } from '../../lib/agent-base-identity'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

type CtrlEnterPaneState = {
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry | undefined>
}

function agentAcceptsCtrlEnterCsiU(agent: PaneForegroundAgentEntry['agent']): boolean {
  // Why base-resolved and guarded: TUI_AGENT_CONFIG is keyed by built-in ids only;
  // a custom agent inherits its base's encoding, an unresolvable id gets plain CR.
  const baseAgent = resolvePaneOwnerBaseAgent(agent ?? undefined)
  return isBuiltInTuiAgent(baseAgent) && TUI_AGENT_CONFIG[baseAgent].ctrlEnterEncoding === 'csi-u'
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
  // Why base-resolved: the veto compares harness identity, and a custom id compares
  // raw-false against its own base's committed title, silently dropping CSI-u.
  if (foreground?.agent != null && resolvePaneOwnerBaseAgent(foreground.agent) !== titleAgent) {
    return false
  }
  return agentAcceptsCtrlEnterCsiU(titleAgent)
}
