import { AGENT_STATE_HISTORY_MAX, type AgentStateHistoryEntry } from './agent-state-history'
import type { AgentStatusEntry, ParsedAgentStatusPayload } from '../contracts/agent-status-types'
import { agentVerdictFields } from './agent-main-agent-verdict'

type CompletedAssistantMessage = Pick<
  AgentStatusEntry,
  'lastCompletedAssistantMessage' | 'lastCompletedAssistantMessageTruncated'
>
type CurrentAssistantMessage = Pick<
  AgentStatusEntry,
  'lastAssistantMessage' | 'lastAssistantMessageIsToolOutput' | 'lastAssistantMessageTruncated'
>

/** Move the previous state into history on switches and retain its first-observed clock; never record session boundaries. */
export function resolveAgentStatusLiveEntryStateHistory(
  existing: AgentStatusEntry | undefined,
  payload: Pick<ParsedAgentStatusPayload, 'state' | 'sessionBoundary'> & CurrentAssistantMessage,
  updatedAt: number
): {
  history: AgentStateHistoryEntry[]
  /** Each message keeps its own flags; a done message moves to the completed slot on a switch. */
  assistantMessageFields: CurrentAssistantMessage & CompletedAssistantMessage
  stateObservedAt: number | undefined
} {
  let history: AgentStateHistoryEntry[] = existing?.stateHistory ?? []
  let completedAssistantMessage = completedAssistantMessageOf(
    existing?.lastCompletedAssistantMessage,
    existing?.lastCompletedAssistantMessageTruncated
  )
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
      completedAssistantMessage = completedAssistantMessageOf(
        existing.lastAssistantMessage,
        existing.lastAssistantMessageTruncated
      )
    }
  }
  return {
    history,
    assistantMessageFields: {
      lastAssistantMessage: payload.lastAssistantMessage,
      lastAssistantMessageIsToolOutput: payload.lastAssistantMessageIsToolOutput,
      ...(payload.lastAssistantMessageTruncated ? { lastAssistantMessageTruncated: true } : {}),
      ...completedAssistantMessage
    },
    stateObservedAt: switchesState ? updatedAt : existing?.stateObservedAt
  }
}

function completedAssistantMessageOf(
  message: string | undefined,
  truncated: boolean | undefined
): CompletedAssistantMessage {
  return {
    ...(message ? { lastCompletedAssistantMessage: message } : {}),
    ...(message && truncated ? { lastCompletedAssistantMessageTruncated: true } : {})
  }
}
