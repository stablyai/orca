import type { AgentMainAgentStatus } from './main-agent-status'
import type { AgentStatusState, AgentWorkingMode } from './agent-status-types'
import type { AgentJournalTurnOutcome } from './agent-turn-outcome'

/** How a main agent's turn ended when it did not end cleanly. `failure` is the provider's own
 *  error; `cancellation` is a stop the user asked for. Wire-carried, so an unknown arm degrades
 *  to absent on every reader. */
export const AGENT_STATUS_TURN_ENDINGS = ['failure', 'cancellation'] as const
export type AgentStatusTurnEnding = (typeof AGENT_STATUS_TURN_ENDINGS)[number]

export function isAgentStatusTurnEnding(value: unknown): value is AgentStatusTurnEnding {
  return AGENT_STATUS_TURN_ENDINGS.some((known) => known === value)
}

/** What an agent row shows. Derived from the separated facts on every read; never stored. */
export type AgentStatusDisplayState =
  | 'waiting'
  | 'blocked'
  | 'failed'
  | 'working'
  | 'monitoring'
  | 'interrupted'
  | 'done'
  | 'unverifiable'
  | 'idle'

type AgentStatusDisplayRow = {
  state: AgentStatusState
  workingMode?: AgentWorkingMode
  interrupted?: boolean
  mainAgent?: AgentMainAgentStatus
}

type AgentMainAgentFact = { state: AgentStatusState; outcome?: AgentJournalTurnOutcome }

/** The main agent's own state and verdict. A row without `mainAgent` is its own main agent. */
export function agentMainAgentFact(row: AgentStatusDisplayRow): AgentMainAgentFact {
  if (row.mainAgent) {
    return {
      state: row.mainAgent.state,
      ...(row.mainAgent.state === 'done' && row.mainAgent.outcome
        ? { outcome: row.mainAgent.outcome }
        : {})
    }
  }
  return {
    state: row.state,
    ...(row.state === 'done' && row.interrupted === true
      ? { outcome: 'cancellation' as const }
      : {})
  }
}

/** How the main agent's latest turn ended. With `mainAgent`, only its record answers; without,
 *  `state`+`interrupted`. */
export function agentMainTurnEnding(row: AgentStatusDisplayRow): AgentStatusTurnEnding | undefined {
  const outcome = agentMainAgentFact(row).outcome
  return outcome === 'failure' || outcome === 'cancellation' ? outcome : undefined
}

/** The child work beyond the main agent, recovered as the residual of the published row over
 *  `mainAgent` (the inverse of `foldAgentLeadStatus`). Derived, never stored. */
export function agentChildWorkDisplay(
  row: AgentStatusDisplayRow
): 'waiting' | 'blocked' | 'working' | 'monitoring' | undefined {
  const main = row.mainAgent
  if (!main) {
    return undefined
  }
  if (
    (row.state === 'waiting' || row.state === 'blocked') &&
    main.state !== 'waiting' &&
    main.state !== 'blocked'
  ) {
    return row.state
  }
  if (main.state === 'done' && row.state === 'working') {
    return row.workingMode === 'monitoring' ? 'monitoring' : 'working'
  }
  return undefined
}

/** One precedence for every display: a live human wait > failed > working/monitoring >
 *  interrupted > done > unverifiable/idle. `decayedTo` is the reader's staleness verdict for
 *  LIVE evidence; an ending is a settled fact about a finished turn, so decay never hides it. */
export function resolveAgentPaneDisplayState(
  row: AgentStatusDisplayRow,
  decayedTo?: 'idle' | 'unverifiable'
): AgentStatusDisplayState {
  const main = agentMainAgentFact(row)
  const childWork = agentChildWorkDisplay(row)
  if (!decayedTo) {
    if (main.state === 'waiting' || main.state === 'blocked') {
      return main.state
    }
    if (childWork === 'waiting' || childWork === 'blocked') {
      return childWork
    }
  }
  const ending = agentMainTurnEnding(row)
  if (ending === 'failure') {
    return 'failed'
  }
  if (decayedTo) {
    return decayedTo
  }
  if (main.state === 'working') {
    return row.state === 'working' && row.workingMode === 'monitoring' ? 'monitoring' : 'working'
  }
  if (childWork === 'working' || childWork === 'monitoring') {
    return childWork
  }
  return ending === 'cancellation' ? 'interrupted' : 'done'
}

export const AGENT_STATUS_DISPLAY_PRIORITY: readonly AgentStatusDisplayState[] = [
  'waiting',
  'blocked',
  'failed',
  'working',
  'monitoring',
  'interrupted',
  'done',
  'unverifiable',
  'idle'
]

/** Worktree/list rollup: one precedence for desktop, phone and CLI. `base` is the reader's
 *  lifecycle rollup, which keeps what rows cannot express (title heuristics, terminal liveness). */
export function resolveAgentWorktreeDisplayStatus<B extends string>(args: {
  base: B
  /** Any row displaying waiting/blocked. */
  hasHumanWait: boolean
  /** Any row displaying failed. */
  hasFailed: boolean
}): B | 'permission' | 'failed' {
  if (args.hasHumanWait || args.base === 'permission') {
    return 'permission'
  }
  if (args.hasFailed) {
    return 'failed'
  }
  return args.base
}

/** "A turn finished cleanly": the star prompt and completed-agent auto-hibernation eligibility. */
export function isCleanAgentTurnCompletion(row: AgentStatusDisplayRow): boolean {
  return row.state === 'done' && agentMainTurnEnding(row) === undefined
}
