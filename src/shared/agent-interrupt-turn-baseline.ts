import type { AgentMainAgentStatus, AgentType } from './agent-status-types'

/** The row facts an interrupt keypress is judged against, read the same way by the renderer
 *  (its store entry) and the server (its hook row). */
export type AgentInterruptTurnFacts = {
  agentType?: AgentType | undefined
  prompt: string
  /** When the row was last written (the renderer's `updatedAt`, the server's `receivedAt`). */
  updatedAt: number
  stateStartedAt: number
  mainAgent?: Pick<AgentMainAgentStatus, 'state' | 'stateStartedAt'>
}

/** The turn a keypress landed in. */
export type AgentInterruptTurnBaseline = {
  agentType: AgentType | undefined
  prompt: string
  updatedAt: number
  stateStartedAt: number
  /** Present only when the row published a working main agent at the keypress. */
  mainAgentStateStartedAt?: number
}

export function equivalentInterruptAgentType(
  actual: AgentType | undefined,
  baseline: AgentType | undefined
): boolean {
  const normalizedActual = actual === 'unknown' ? undefined : actual
  const normalizedBaseline = baseline === 'unknown' ? undefined : baseline
  return normalizedActual === normalizedBaseline
}

export function captureAgentInterruptTurnBaseline(
  facts: AgentInterruptTurnFacts
): AgentInterruptTurnBaseline {
  return {
    agentType: facts.agentType,
    prompt: facts.prompt,
    updatedAt: facts.updatedAt,
    stateStartedAt: facts.stateStartedAt,
    ...(facts.mainAgent?.state === 'working'
      ? { mainAgentStateStartedAt: facts.mainAgent.stateStartedAt }
      : {})
  }
}

/**
 * Whether the row still shows the turn the interrupt key was pressed in. With a main agent fact,
 * only the main agent's own turn decides: a Stop, a wait or a new prompt moves it, while child
 * events and same-state restatements (which re-stamp the row) do not. A row from a host too old
 * to publish `mainAgent` has nothing finer than its write time.
 */
export function isAgentInterruptTurnCurrent(
  baseline: AgentInterruptTurnBaseline,
  current: AgentInterruptTurnFacts
): boolean {
  if (
    !equivalentInterruptAgentType(current.agentType, baseline.agentType) ||
    current.prompt !== baseline.prompt
  ) {
    return false
  }
  if (baseline.mainAgentStateStartedAt !== undefined && current.mainAgent) {
    return (
      current.mainAgent.state === 'working' &&
      current.mainAgent.stateStartedAt === baseline.mainAgentStateStartedAt
    )
  }
  return (
    current.updatedAt === baseline.updatedAt && current.stateStartedAt === baseline.stateStartedAt
  )
}
