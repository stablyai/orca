import {
  AGENT_STATE_HISTORY_MAX,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type ParsedAgentStatusPayload
} from './agent-status-types'
import { agentVerdictFields } from './agent-main-agent-verdict'

/** Move the previous state into history on switches and retain its first-observed clock; never record session boundaries. */
export function resolveAgentStatusLiveEntryStateHistory(
  existing: AgentStatusEntry | undefined,
  payload: Pick<ParsedAgentStatusPayload, 'state' | 'sessionBoundary'>,
  updatedAt: number
): {
  history: AgentStateHistoryEntry[]
  lastCompletedAssistantMessage: string | undefined
  stateObservedAt: number | undefined
} {
  let history: AgentStateHistoryEntry[] = existing?.stateHistory ?? []
  let lastCompletedAssistantMessage = existing?.lastCompletedAssistantMessage
  const boundaryLandsOnRealDone =
    existing?.state === 'done' &&
    existing.sessionBoundary !== true &&
    payload.state === 'done' &&
    payload.sessionBoundary === true
  const switchesState = existing?.state !== payload.state || boundaryLandsOnRealDone
  if (
    existing &&
    switchesState &&
    !(existing.state === 'done' && existing.sessionBoundary === true)
  ) {
    history = [
      ...history,
      {
        state: existing.state,
        prompt: existing.prompt,
        startedAt: existing.stateStartedAt,
        observedAt: existing.stateObservedAt,
        ...agentVerdictFields(existing)
      }
    ]
    if (history.length > AGENT_STATE_HISTORY_MAX) {
      history = history.slice(history.length - AGENT_STATE_HISTORY_MAX)
    }
    if (existing.state === 'done') {
      lastCompletedAssistantMessage = existing.lastAssistantMessage
    }
  }
  return {
    history,
    lastCompletedAssistantMessage,
    stateObservedAt: switchesState ? updatedAt : existing?.stateObservedAt
  }
}
