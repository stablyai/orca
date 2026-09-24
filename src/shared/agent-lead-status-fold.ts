import type { AgentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentMainAgentStatus, AgentStatusState, AgentWorkingMode } from './agent-status-types'

export type AgentLeadStatusFoldInput = {
  /** The main agent's own turn state. Anything but `done` wins over child work, except that a
   *  child waiting on a human outranks a working main agent. */
  leadState: AgentStatusState
  /** A lead turn that ended by interrupt keeps a watch loop from reading as monitoring;
   *  live agent work still counts, because it outlives the interrupt. */
  interrupted: boolean
  childWorkLiveness: AgentChildWorkLiveness
}

export type AgentLeadStatusResolution = {
  stateName: AgentStatusState
  workingMode?: AgentWorkingMode
}

/** A cancelled turn is the one verdict the display fold reads off the main agent record. */
export function mainAgentTurnInterrupted(
  record: Pick<AgentMainAgentStatus, 'outcome'> | undefined
): boolean {
  return record?.outcome === 'cancellation'
}

/**
 * One fold for every lane that publishes a main agent's status: a child waiting
 * on a human makes the row wait whatever the main agent is doing, a settled main
 * agent with live agent work is still working, and one with only watch loops is
 * monitoring. Every lane derives the liveness from its own evidence, but the
 * policy must not differ.
 */
export function foldAgentLeadStatus(input: AgentLeadStatusFoldInput): AgentLeadStatusResolution {
  // The main agent's own request for a human keeps its own vocabulary (`blocked` in the
  // structured lane); a child's request surfaces only when the main agent is not already asking.
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
  if (input.childWorkLiveness === 'monitoring' && !input.interrupted) {
    return { stateName: 'working', workingMode: 'monitoring' }
  }
  return { stateName: 'done' }
}

/** The main agent settled and live child work is the only thing holding the row open. Derived,
 *  never stored: a stored copy could disagree with the two facts it is made of. */
export function isAgentStatusHeldOpenByChildWork(row: {
  state: AgentStatusState
  mainAgent?: Pick<AgentMainAgentStatus, 'state'>
}): boolean {
  return row.mainAgent?.state === 'done' && row.state !== 'done'
}

/** The main agent's clock follows the same continuity rule as the row's: an unchanged main agent state
 *  keeps the instant it first appeared, a changed one starts at `now`. A caller that knows
 *  the real instant (a restored stash, a journal record) passes it and wins. */
export function continueMainAgentStatus(
  previous: Pick<AgentMainAgentStatus, 'state' | 'stateStartedAt'> | undefined,
  next: {
    state: AgentStatusState
    outcome?: AgentMainAgentStatus['outcome']
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
    stateStartedAt
  }
}
