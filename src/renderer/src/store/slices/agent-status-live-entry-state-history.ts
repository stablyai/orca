import {
  AGENT_STATE_HISTORY_MAX,
  type AgentStateHistoryEntry,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { AgentStatusPayload } from './agent-status-contract'

/** The history a live entry carries after this write, and when its state was first observed. A
 *  state switch moves the previous state into history; a session boundary is never recorded. */
export function resolveAgentStatusLiveEntryStateHistory(
  existing: AgentStatusEntry | undefined,
  payload: Pick<AgentStatusPayload, 'state' | 'sessionBoundary'>,
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
        interrupted: existing.interrupted,
        ...(existing.state === 'done' && existing.mainAgent?.outcome
          ? { outcome: existing.mainAgent.outcome }
          : {})
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
