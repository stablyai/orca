import type { AppState } from '@/store/types'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import {
  readAgentProcessPresence,
  type AgentProcessPresence
} from '../../../../shared/agent-process-presence'

/** Called only after the existing pane and execution-host admission checks. */
export function applyAgentPresenceEvent(
  store: AppState,
  paneKey: string,
  data: AgentStatusIpcPayload,
  connectionId: string | null | undefined,
  worktreeId: string | undefined
): AgentProcessPresence | null | undefined {
  const previous = store.agentPresenceByPaneKey?.[paneKey]
  if (
    previous?.connectionId === connectionId &&
    previous &&
    data.receivedAt < previous.receivedAt
  ) {
    return null
  }
  const presence = readAgentProcessPresence(data.agentPresence)
  if (presence) {
    store.recordAgentPresence(paneKey, {
      presence,
      receivedAt: data.receivedAt,
      connectionId,
      worktreeId
    })
  }
  return presence
}
