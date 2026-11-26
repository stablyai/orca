/** The host deletes an Orca chat for good (agentSession.delete); an older host keeps every chat. */
export const AGENT_SESSION_DELETE_RUNTIME_CAPABILITY = 'agentSession.delete.v1' as const
// Why: hosts before this advertise delete.v1 but refuse agentSession.delete from a phone.
export const AGENT_SESSION_PHONE_DELETE_RUNTIME_CAPABILITY =
  'agent-session.delete.phone.v1' as const

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

type ChatDeleteTranslate = (
  key: string,
  fallback: string,
  values?: Record<string, unknown>
) => string

/** What a refused delete says, on the desktop and the phone. */
export function orcaChatDeleteRefusalText(
  t: ChatDeleteTranslate,
  reason: OrcaChatDeleteRefusal
): string {
  if (reason === 'group') {
    return t('chats.delete.groupRoom', "A group room's chat can't be deleted")
  }
  if (reason === 'home') {
    return t('chats.delete.home', "A managed agent's Home Chat can't be deleted")
  }
  // A reason from a newer host falls back to the plain failure.
  return reason === 'workers'
    ? t('chats.delete.workerOwed', 'An orchestration still waits on this chat')
    : t('chats.delete.failed', "Couldn't delete the chat")
}
