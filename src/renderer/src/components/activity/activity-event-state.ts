import { resolveAgentRowState } from '../../../../shared/agent-status/presentation/agent-row-decay-state'

import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentStatusState as ActivityEventState
} from '../../../../shared/agent-status/contracts/agent-status-types'

import type { ActivityHookLiveAgentState, ActivityLiveAgentState } from './activity-thread-types'

function isActivityHookLiveAgentState(
  state: AgentStatusState | 'idle'
): state is ActivityHookLiveAgentState {
  return state === 'working' || state === 'blocked' || state === 'waiting'
}

/** The card's row state; a stale working pane with a live PTY stays listed as unverifiable instead of vanishing. */
export function activityLiveAgentState(
  entry: AgentStatusEntry,
  now: number,
  hasLivePty: boolean
): ActivityLiveAgentState | null {
  const state = resolveAgentRowState(entry, now, hasLivePty)
  if (state === 'unverifiable') {
    // Stale blocked/waiting keep their attention status through the historical event path.
    return entry.state === 'working' ? state : null
  }
  if (!isActivityHookLiveAgentState(state)) {
    return null
  }
  return state === 'working' && entry.workingMode === 'monitoring' ? 'monitoring' : state
}

/** Fresh hook state only, for counts that must not include unverifiable rows. */
export function freshActivityLiveAgentState(
  entry: AgentStatusEntry,
  now: number
): ActivityLiveAgentState | null {
  return activityLiveAgentState(entry, now, false)
}

/** Unverifiable rows stay listed but are not running work. */
export function isRunningActivityState(state: ActivityLiveAgentState | null | undefined): boolean {
  return state != null && state !== 'unverifiable'
}

export function isHistoricalActivityState(
  state: string
): state is Extract<ActivityEventState, 'done' | 'blocked' | 'waiting'> {
  return state === 'done' || state === 'blocked' || state === 'waiting'
}
