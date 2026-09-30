import type { AgentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentMainAgentStatus, AgentStatusState, AgentWorkingMode } from './agent-status-types'

export type AgentLeadStatusFoldInput = {
  /** The main agent's own turn state. Anything but `done` wins over child work, except that a
   *  child waiting on a human outranks a working main agent. */
  leadState: AgentStatusState
  childWorkLiveness: AgentChildWorkLiveness
}

export type AgentLeadStatusResolution = {
  stateName: AgentStatusState
  workingMode?: AgentWorkingMode
}

/** The row's `interrupted` flag for readers that predate `mainAgent`, derived from the main agent's
 *  verdict. The display fold never reads it. */
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
 *
 * How the main agent's turn ended is not an input. A cancel is a verdict on the main agent
 * (`mainAgent.outcome`), never on the shell or subagent it left running: that work
 * leaves the fold only when it reports its own end or the session ends.
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
  if (input.childWorkLiveness === 'monitoring') {
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

/**
 * The stats question, "does this row accrue agent time": a `working` row accrues unless it is a watch
 * loop. The fold emits `monitoring` only for a settled main agent, so this is the main agent's turn or
 * its live agent child work; a row waiting on the user accrues nothing, whoever raised the prompt.
 * Reads only the combined row, so an old host that publishes no `mainAgent` is read the same way.
 * Not a liveness gate: a watch loop is still live work that lifecycle gates must keep honoring.
 */
export function isAgentTimeAccruing(row: {
  state: AgentStatusState
  workingMode?: AgentWorkingMode
}): boolean {
  return row.state === 'working' && row.workingMode !== 'monitoring'
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
