import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusState
} from '../../../../shared/agent-status-types'
import { resolveAgentStatusPresentation } from '../../../../shared/agent-execution-observation'
import type {
  ActivityEventState,
  ActivityHookLiveAgentState,
  ActivityLiveAgentState
} from './activity-thread-types'

function isActivityHookLiveAgentState(
  state: AgentStatusState
): state is ActivityHookLiveAgentState {
  return state === 'working' || state === 'blocked' || state === 'waiting'
}

export function freshActivityLiveAgentState(
  entry: AgentStatusEntry,
  now: number
): ActivityLiveAgentState | null {
  if (entry.executionObservation) {
    const presentation = resolveAgentStatusPresentation(entry, now, AGENT_STATUS_STALE_AFTER_MS)
    if (
      presentation.state !== 'working' &&
      presentation.state !== 'blocked' &&
      presentation.state !== 'waiting'
    ) {
      return null
    }
    return presentation.state === 'working' && entry.workingMode === 'monitoring'
      ? 'monitoring'
      : presentation.state
  }
  if (
    !isActivityHookLiveAgentState(entry.state) ||
    !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
  ) {
    return null
  }
  return entry.state === 'working' && entry.workingMode === 'monitoring'
    ? 'monitoring'
    : entry.state
}

export function isHistoricalActivityState(
  state: string
): state is Extract<ActivityEventState, 'done' | 'blocked' | 'waiting'> {
  return state === 'done' || state === 'blocked' || state === 'waiting'
}
