import type { AgentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentMainAgentStatus, AgentStatusState, AgentWorkingMode } from './agent-status-types'

export type AgentLeadStatusFoldInput = {
  /** Lead state wins except human-waiting children outrank working. */
  leadState: AgentStatusState
  childWorkLiveness: AgentChildWorkLiveness
}

export type AgentLeadStatusResolution = {
  stateName: AgentStatusState
  workingMode?: AgentWorkingMode
}

/** Legacy interrupted means user cancellation only; it is never a display-fold input. */
export function mainAgentTurnInterrupted(
  record: Pick<AgentMainAgentStatus, 'outcome'> | undefined
): boolean {
  return record?.outcome === 'cancellation'
}

/** Share child-wait/live-work/monitoring policy across lanes. Lead verdicts never retire surviving shells or subagents; only their own end or session death does. */
export function foldAgentLeadStatus(input: AgentLeadStatusFoldInput): AgentLeadStatusResolution {
  // Keep the lead's own waiting/blocked vocabulary before considering child waits.
  if (input.leadState === 'waiting' || input.leadState === 'blocked') {
    return { stateName: input.leadState }
  }
  if (input.childWorkLiveness === 'waiting') {
    return { stateName: 'waiting' }
  }
  if (input.leadState !== 'done') {
    return { stateName: input.leadState }
  }
  if (input.childWorkLiveness === 'working') {
    return { stateName: 'working' }
  }
  if (input.childWorkLiveness === 'monitoring') {
    return { stateName: 'working', workingMode: 'monitoring' }
  }
  return { stateName: 'done' }
}

/** Derive child-held status from lead and combined states; storing it could contradict either fact. */
export function isAgentStatusHeldOpenByChildWork(row: {
  state: AgentStatusState
  mainAgent?: Pick<AgentMainAgentStatus, 'state'>
}): boolean {
  return row.mainAgent?.state === 'done' && row.state !== 'done'
}

/** Accrue working time except watch loops; waits accrue none. Read combined state for older hosts. Monitoring stays live for lifecycle gates despite accruing no time. */
export function isAgentTimeAccruing(row: {
  state: AgentStatusState
  workingMode?: AgentWorkingMode
}): boolean {
  return row.state === 'working' && row.workingMode !== 'monitoring'
}

/** Same lead state retains its start clock; a changed state starts now unless the caller supplies a known restored/journal time. */
export function continueMainAgentStatus(
  previous: Pick<AgentMainAgentStatus, 'state' | 'stateStartedAt'> | undefined,
  next: {
    state: AgentStatusState
    outcome?: AgentMainAgentStatus['outcome']
    stopping?: true
    stateStartedAt?: number
  },
  now: number
): AgentMainAgentStatus {
  const stateStartedAt =
    next.stateStartedAt ??
    (previous && previous.state === next.state ? previous.stateStartedAt : now)
  return {
    state: next.state,
    ...(next.state === 'done' && next.outcome ? { outcome: next.outcome } : {}),
    ...(next.state === 'working' && next.stopping ? { stopping: true as const } : {}),
    stateStartedAt
  }
}
