// Why the Orca running a chat stopped in the middle of a reply: a quit, an update, or a crash. The
// host states it on its row about the cut turn (`orcaStop`); a client names it, and offers Continue.
// Open on the wire: a cause this build does not know reads as none, and the row keeps its words.

export const AGENT_SESSION_ORCA_STOP_CAUSES = ['update', 'quit', 'crash'] as const
/** The row's presentation, so a client that re-words host rows it can't name passes it through. */
export const AGENT_SESSION_ORCA_STOP_PRESENTATION = 'orca-stop'
export type AgentSessionOrcaStopCause = (typeof AGENT_SESSION_ORCA_STOP_CAUSES)[number]
export type AgentSessionOrcaStop = { cause: AgentSessionOrcaStopCause }

export function isAgentSessionOrcaStopCause(value: unknown): value is AgentSessionOrcaStopCause {
  return AGENT_SESSION_ORCA_STOP_CAUSES.some((cause) => cause === value)
}

/** The stop a row states, when this build knows its cause. */
export function readAgentSessionOrcaStop(value: unknown): AgentSessionOrcaStop | undefined {
  const cause =
    typeof value === 'object' && value !== null && 'cause' in value ? value.cause : undefined
  return isAgentSessionOrcaStopCause(cause) ? { cause } : undefined
}
