import { AGENT_SESSION_ID_MAX_LENGTH } from './agent-session-wire'

/**
 * Where a forked session came from: the chat it is copied out of, and the point the provider cuts
 * the copy at. Written once, when the fork's record is reserved, and never changed after.
 */
export type AgentSessionForkOrigin = {
  sessionId: string
  /** The row the person forked from. */
  itemId: string
  /** The parent's provider conversation when it was forked: Claude's session id, Codex's thread id. */
  providerSessionId: string
  /** The turn's `agentJournalTurnForkPoint`: the provider copies the conversation through it. */
  forkPoint: string
}

function isBounded(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= AGENT_SESSION_ID_MAX_LENGTH
  )
}

export function isAgentSessionForkOrigin(value: unknown): value is AgentSessionForkOrigin {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a non-null object, checked above; every field read is validated below.
  const { sessionId, itemId, providerSessionId, forkPoint } = value as Record<string, unknown>
  return (
    isBounded(sessionId) &&
    isBounded(itemId) &&
    isBounded(providerSessionId) &&
    isBounded(forkPoint)
  )
}
