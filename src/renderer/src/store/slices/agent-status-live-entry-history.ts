import {
  AGENT_STATE_HISTORY_MAX,
  type AgentStateHistoryEntry,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { AgentStatusPayload } from './agent-status-contract'

/** Appends the outgoing state to the pane's bounded history when this write changes state. */
export function advanceAgentStateHistory(
  existing: AgentStatusEntry | undefined,
  payload: AgentStatusPayload
): {
  history: AgentStateHistoryEntry[]
  lastCompletedAssistantMessage: string | undefined
} {
  let history: AgentStateHistoryEntry[] = existing?.stateHistory ?? []
  let lastCompletedAssistantMessage = existing?.lastCompletedAssistantMessage
  const boundaryLandsOnRealDone =
    existing?.state === 'done' &&
    existing.sessionBoundary !== true &&
    payload.state === 'done' &&
    payload.sessionBoundary === true
  if (
    existing &&
    (existing.state !== payload.state || boundaryLandsOnRealDone) &&
    !(existing.state === 'done' && existing.sessionBoundary === true)
  ) {
    history = [
      ...history,
      {
        state: existing.state,
        prompt: existing.prompt,
        startedAt: existing.stateStartedAt,
        interrupted: existing.interrupted
      }
    ]
    if (history.length > AGENT_STATE_HISTORY_MAX) {
      history = history.slice(history.length - AGENT_STATE_HISTORY_MAX)
    }
    if (existing.state === 'done') {
      lastCompletedAssistantMessage = existing.lastAssistantMessage
    }
  }
  return { history, lastCompletedAssistantMessage }
}
