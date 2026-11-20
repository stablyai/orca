/** The host deletes an Orca chat for good (agentSession.delete); an older host keeps every chat. */
export const AGENT_SESSION_DELETE_RUNTIME_CAPABILITY = 'agentSession.delete.v1' as const

/** `replying`: a turn or queued input is running; `workers`: workers it started are still running. */
export type OrcaChatDeleteRefusal = 'replying' | 'workers' | 'not-found' | 'unavailable'

export type OrcaChatDeleteResult =
  | { outcome: 'deleted' }
  | { outcome: 'refused'; reason: OrcaChatDeleteRefusal }
