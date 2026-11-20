/** The host deletes an Orca chat for good (agentSession.delete); an older host keeps every chat. */
export const AGENT_SESSION_DELETE_RUNTIME_CAPABILITY = 'agentSession.delete.v1' as const

/** `replying`: a turn or queued input is running, or its state can't be proven at rest; `workers`:
 *  workers it started may still run; `group`: a group room member's chat, which the room still uses. */
export type OrcaChatDeleteRefusal = 'replying' | 'workers' | 'group' | 'not-found' | 'unavailable'

export type OrcaChatDeleteResult =
  /** `historyKept`: the chat is gone but the agent's own history of it stayed (an agent Orca can't
   *  delete history for, or a failed removal), so its CLI could still list it. */
  { outcome: 'deleted'; historyKept?: true } | { outcome: 'refused'; reason: OrcaChatDeleteRefusal }
