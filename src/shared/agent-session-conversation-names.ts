import { isAgentSessionConversationName } from './agent-session/agent-session-conversation-name'
import type { AgentSessionConversationName, AgentSessionStatusEvent } from './agent-session-wire'

export type AgentSessionConversationNames = ReadonlyMap<string, AgentSessionConversationName>

function isNamingNote(value: unknown): value is AgentSessionConversationName {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId ||
    !('conversationName' in value) ||
    (value.conversationName !== null && !isAgentSessionConversationName(value.conversationName))
  ) {
    return false
  }
  if (!('namingError' in value) || value.namingError === undefined) {
    return true
  }
  const error = value.namingError
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.length > 0 &&
    error.message.length <= 1024 &&
    'failedAt' in error &&
    typeof error.failedAt === 'number' &&
    Number.isFinite(error.failedAt)
  )
}

/** Stream order is title order; metadata never asserts a turn or live observation. */
export function foldAgentSessionConversationNames(
  names: AgentSessionConversationNames,
  event: AgentSessionStatusEvent
): AgentSessionConversationNames {
  const sessions =
    event.type === 'snapshot' ? event.sessions : event.type === 'status' ? [event.session] : []
  const notes =
    event.type === 'snapshot' && Array.isArray(event.conversationNames)
      ? event.conversationNames
      : []
  let next: Map<string, AgentSessionConversationName> | undefined
  for (const note of [...sessions, ...notes]) {
    if (!isNamingNote(note)) {
      continue
    }
    const previous = (next ?? names).get(note.sessionId)
    if (
      previous?.conversationName === note.conversationName &&
      previous?.namingError?.message === note.namingError?.message &&
      previous?.namingError?.failedAt === note.namingError?.failedAt
    ) {
      continue
    }
    next ??= new Map(names)
    next.set(note.sessionId, {
      sessionId: note.sessionId,
      conversationName: note.conversationName,
      ...(note.namingError ? { namingError: note.namingError } : {})
    })
  }
  return next ?? names
}
