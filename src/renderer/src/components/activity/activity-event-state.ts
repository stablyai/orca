import {
  isAgentStatusFresh,
  AGENT_STATUS_STALE_AFTER_MS
} from '../../../../shared/agent-status/contracts/agent-status-freshness'

import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentStatusState as ActivityEventState
} from '../../../../shared/agent-status/contracts/agent-status-types'

import type { ActivityHookLiveAgentState, ActivityLiveAgentState } from './activity-thread-types'

function isActivityHookLiveAgentState(
  state: AgentStatusState
): state is ActivityHookLiveAgentState {
  return state === 'working' || state === 'blocked' || state === 'waiting'
}

export function freshActivityLiveAgentState(
  entry: AgentStatusEntry,
  now: number
): ActivityLiveAgentState | null {
  if (
    !isActivityHookLiveAgentState(entry.state) ||
    !isAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
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
