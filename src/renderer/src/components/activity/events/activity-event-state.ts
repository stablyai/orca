import { resolveAgentRowState } from '../../../../../shared/agent-status/presentation/agent-row-decay-state'

import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentStatusState as ActivityEventState
} from '../../../../../shared/agent-status/contracts/agent-status-types'

import type {
  ActivityHookLiveAgentState,
  ActivityLiveAgentState
} from '../threads/activity-thread-types'

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

/** Whether any pane has a fresh live turn or a blocked migration; the sidebar badge builds only then. */
export function hasFreshActivityLiveAgent(
  statuses: ReadonlyMap<string, AgentStatusEntry>,
  migrationUnsupportedByPtyId: Readonly<Record<string, unknown>>
): boolean {
  if (Object.keys(migrationUnsupportedByPtyId).length > 0) {
    return true
  }
  const now = Date.now()
  for (const entry of statuses.values()) {
    if (freshActivityLiveAgentState(entry, now)) {
      return true
    }
  }
  return false
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
