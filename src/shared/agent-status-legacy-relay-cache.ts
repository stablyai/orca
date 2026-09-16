import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import {
  admitLegacyAgentStatus,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from './agent-status-legacy-adapter'

export function cacheRelayLegacyAgentStatus(
  state: HookListenerState,
  entry: AgentHookEventPayload,
  maxPanes: number,
  dropPane: (paneKey: string) => void
): boolean {
  if (
    !admitLegacyAgentStatus(
      state,
      'relay-status-cache',
      entry,
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE,
      { moveToEnd: true }
    )
  ) {
    return false
  }
  while (state.lastStatusByPaneKey.size > maxPanes) {
    const oldest = state.lastStatusByPaneKey.keys().next().value
    if (oldest === undefined) {
      return false
    }
    dropPane(oldest)
  }
  return true
}
