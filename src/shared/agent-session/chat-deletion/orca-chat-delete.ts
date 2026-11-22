/** The host deletes an Orca chat for good (agentSession.delete); an older host keeps every chat. */
export const AGENT_SESSION_DELETE_RUNTIME_CAPABILITY = 'agentSession.delete.v1' as const

/** `workers`: the chat is a worker an orchestration still waits on; `group`: a group room member's
 *  chat, which the room still uses; `home`: a managed agent's live Home Chat. */
export type OrcaChatDeleteRefusal = 'workers' | 'group' | 'home' | 'not-found' | 'unavailable'

export type ChatDeleteSettings = {
  /** Why: a deleted chat never comes back; keep this skip separate from other deletions. */
  skipDeleteChatConfirm: boolean
}

export type OrcaChatDeleteResult =
  | { outcome: 'deleted' }
  | { outcome: 'refused'; reason: OrcaChatDeleteRefusal }
