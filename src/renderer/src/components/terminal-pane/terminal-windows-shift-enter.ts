import type { AgentType } from '../../../../shared/agent-status-types'
import { resolveCommittedTitleAgentType } from '../../lib/pane-agent-evidence'
import { resolveTuiAgentConfig } from '../../../../shared/custom-tui-agents'
import type { CustomTuiAgent, DeletedCustomTuiAgent } from '../../../../shared/types'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

export type WindowsShiftEnterEncoding = 'alt-enter' | 'csi-u'

type CustomTuiAgentSignals = {
  customTuiAgents?: readonly CustomTuiAgent[] | null
  deletedCustomTuiAgents?: readonly DeletedCustomTuiAgent[] | null
}

type WindowsShiftEnterAgentSignals = CustomTuiAgentSignals & {
  foreground?: PaneForegroundAgentEntry
  launchAgentType?: AgentType
}

type WindowsShiftEnterPaneState = {
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry | undefined>
  agentLaunchConfigByPaneKey: Record<string, { identity: { agentType?: AgentType } } | undefined>
  settings?: CustomTuiAgentSignals | null
}

/** Resolve without key-path PTY I/O; current process/shell evidence overrides
 * launch ownership. Hook status is excluded because PTY output can forge it. */
export function resolveWindowsShiftEnterEncoding(
  signals: WindowsShiftEnterAgentSignals
): WindowsShiftEnterEncoding {
  if (signals.foreground?.shellForeground) {
    return 'alt-enter'
  }
  // Why: a pending confirmation retains the last allowlisted byte capability;
  // CSI-u is inert in a shell, while Esc+CR can submit in Pi.
  const agent =
    signals.foreground?.routingTrusted === true ||
    signals.foreground?.routingConfirmationPending === true
      ? signals.foreground.agent
      : null
  // Why: a custom id inherits its base harness's Shift+Enter encoding; resolve
  // the base before reading the built-in-only config so a raw custom id doesn't
  // silently fall back to alt-enter (or index an undefined entry).
  const config = resolveTuiAgentConfig(
    agent,
    signals.customTuiAgents,
    signals.deletedCustomTuiAgents
  )
  return config?.windowsShiftEnterEncoding ?? 'alt-enter'
}

/** Resolves only pane-keyed evidence so a split sibling cannot inherit tab ownership. */
export function resolveWindowsShiftEnterEncodingForPane(
  state: WindowsShiftEnterPaneState,
  paneKey: string,
  terminalTitle?: string
): WindowsShiftEnterEncoding {
  const foreground = state.paneForegroundAgentByPaneKey[paneKey]
  const encoding = resolveWindowsShiftEnterEncoding({
    foreground: state.paneForegroundAgentByPaneKey[paneKey],
    launchAgentType: state.agentLaunchConfigByPaneKey[paneKey]?.identity.agentType,
    customTuiAgents: state.settings?.customTuiAgents,
    deletedCustomTuiAgents: state.settings?.deletedCustomTuiAgents
  })
  if (
    encoding === 'csi-u' ||
    !terminalTitle ||
    foreground?.routingTrusted === true ||
    foreground?.routingRevoked === true ||
    foreground?.shellForeground === true
  ) {
    return encoding
  }
  // Why: strict pane-local titles recover Pi/Droid through process-scan gaps without overriding process or shell proof.
  const titleAgent = resolveCommittedTitleAgentType(terminalTitle)
  return titleAgent
    ? (resolveTuiAgentConfig(titleAgent)?.windowsShiftEnterEncoding ?? 'alt-enter')
    : 'alt-enter'
}
