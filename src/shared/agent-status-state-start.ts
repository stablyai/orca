import type { AgentStatusState } from './agent-status-types'

export type AgentStatusStateStart = {
  state: AgentStatusState
  stateStartedAt: number
}

/**
 * When a row's `stateStartedAt` moves. One rule for every writer: the clock is the start of the
 * state the row is in, so it survives republished evidence and only resets when the state itself
 * changes (or a same-state write is a new turn, which only Command Code can be).
 *
 * `done` is not an exception. `agentEntryCompletionAt` reads a settled row's `stateStartedAt` as
 * its completion time, so a writer that restamped it on every republish would keep re-dating a
 * finished turn.
 */
export function resolveAgentStatusStateStartedAt(args: {
  previous: AgentStatusStateStart | undefined
  nextState: AgentStatusState
  observedAt: number
  /** A same-state write that is nevertheless a new turn; Command Code has no prompt hook. */
  newTurn?: boolean
}): number {
  return args.previous && args.previous.state === args.nextState && args.newTurn !== true
    ? args.previous.stateStartedAt
    : args.observedAt
}
