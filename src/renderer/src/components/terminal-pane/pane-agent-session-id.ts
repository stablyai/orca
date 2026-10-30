import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'

export type PaneAgentSessionIdState = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord | undefined>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry | undefined>
}

/** Resolve exact-pane provider identity for live actions or copying the retained session ID. */
export function resolvePaneAgentSessionId(
  state: PaneAgentSessionIdState,
  paneKey: string,
  policy: 'live' | 'retained' = 'live'
): string | null {
  // The common pattern keeps ended-session identity copyable without claiming that its interface is live.
  if (policy === 'live' && state.paneForegroundAgentByPaneKey[paneKey]?.shellForeground === true) {
    return null
  }
  const live = state.agentStatusByPaneKey[paneKey]
  if (live && live.restoredUnconfirmed !== true) {
    return live.providerSession?.id ?? null
  }
  return state.sleepingAgentSessionsByPaneKey[paneKey]?.providerSession.id ?? null
}
