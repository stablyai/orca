import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { PaneForegroundAgentEntry } from '../../../store/slices/agent-status/pane-foreground-agent'
import { isWindowsUserAgent } from '../../../app-shell/platform/user-agent-platform'

export type PaneAgentSessionIdState = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord | undefined>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry | undefined>
}

/** Resolves the provider session owned by one exact terminal pane, while its agent is still live. */
export function resolvePaneAgentSessionId(
  state: PaneAgentSessionIdState,
  paneKey: string
): string | null {
  // Gate durable resume records on shell return too; they intentionally outlive the agent for cold restore.
  if (state.paneForegroundAgentByPaneKey[paneKey]?.shellForeground === true) {
    return null
  }
  const live = state.agentStatusByPaneKey[paneKey]
  if (live && live.restoredUnconfirmed !== true) {
    return live.providerSession?.id ?? null
  }
  return state.sleepingAgentSessionsByPaneKey[paneKey]?.providerSession.id ?? null
}

/** Copy Agent ID's gate. A trusted live row offers it only when its host stamped an id, which
 *  older hosts never do; a sleeping record only when this app owns the pane on a non-Windows
 *  host, the one place its saved provider key resolves. */
export function canPaneOfferAgentId(
  state: PaneAgentSessionIdState,
  paneKey: string,
  ownerIsThisApp: boolean
): boolean {
  if (state.paneForegroundAgentByPaneKey[paneKey]?.shellForeground === true) {
    return false
  }
  const live = state.agentStatusByPaneKey[paneKey]
  if (live && live.restoredUnconfirmed !== true) {
    return Boolean(live.orcaSessionId)
  }
  const record = state.sleepingAgentSessionsByPaneKey[paneKey]
  return (
    Boolean(record?.providerSession.id) &&
    !record?.connectionId &&
    ownerIsThisApp &&
    !isWindowsUserAgent()
  )
}
