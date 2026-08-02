import type { AgentType } from '../../../../shared/agent-status-types'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

export type WindowsShiftEnterEncoding = 'alt-enter' | 'csi-u'

type WindowsShiftEnterAgentSignals = {
  foreground?: PaneForegroundAgentEntry
  launchAgentType?: AgentType
}

type WindowsShiftEnterPaneState = {
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry | undefined>
  agentLaunchConfigByPaneKey: Record<string, { identity: { agentType?: AgentType } } | undefined>
}

/** Resolve without key-path PTY I/O; current process/shell evidence overrides
 * launch ownership. Hook status is excluded because PTY output can forge it. */
export function resolveWindowsShiftEnterEncoding(
  signals: WindowsShiftEnterAgentSignals
): WindowsShiftEnterEncoding {
  if (signals.foreground?.shellForeground) {
    return 'alt-enter'
  }
  // Why: an entry marks a newer command/process generation. Until fresh
  // confirmation trusts it, stale launch ownership must not route input.
  // Launch metadata is only an expectation used to start confirmation; it is
  // never byte-routing authority because warm/stale daemon state can outlive
  // the process that originally launched the agent.
  const agent = signals.foreground?.routingTrusted === true ? signals.foreground.agent : null
  return agent ? (TUI_AGENT_CONFIG[agent].windowsShiftEnterEncoding ?? 'alt-enter') : 'alt-enter'
}

/** Resolves only pane-keyed evidence so a split sibling cannot inherit tab ownership. */
export function resolveWindowsShiftEnterEncodingForPane(
  state: WindowsShiftEnterPaneState,
  paneKey: string
): WindowsShiftEnterEncoding {
  return resolveWindowsShiftEnterEncoding({
    foreground: state.paneForegroundAgentByPaneKey[paneKey],
    launchAgentType: state.agentLaunchConfigByPaneKey[paneKey]?.identity.agentType
  })
}
