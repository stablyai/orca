import { isAgentSessionConversationName } from './agent-session-conversation-name'
import { agentSessionForkNamingEqual, type AgentSessionForkNaming } from './agent-session-fork-name'
import type {
  AgentSessionConversationName,
  AgentSessionNamingError,
  AgentSessionStatusEvent
} from './agent-session-wire'

export type AgentSessionConversationNames = ReadonlyMap<string, AgentSessionConversationName>

/** Undefined when the frame carries no error; false when it carries a malformed one. */
function readNamingError(error: unknown): AgentSessionNamingError | undefined | false {
  if (error === undefined) {
    return undefined
  }
  if (
    typeof error !== 'object' ||
    error === null ||
    !('message' in error) ||
    typeof error.message !== 'string' ||
    error.message.length === 0 ||
    error.message.length > 1024 ||
    !('failedAt' in error) ||
    typeof error.failedAt !== 'number' ||
    !Number.isFinite(error.failedAt)
  ) {
    return false
  }
  const messageCode =
    'messageCode' in error && typeof error.messageCode === 'string' ? error.messageCode : undefined
  return {
    message: error.message,
    failedAt: error.failedAt,
    ...(messageCode !== undefined ? { messageCode } : {})
  }
}

function readForkNaming(value: unknown): AgentSessionForkNaming | null | undefined {
  if (value === null) {
    return null
  }
  if (
    typeof value !== 'object' ||
    !('sessionId' in value) ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId
  ) {
    return undefined
  }
  const plainName = 'plainName' in value ? value.plainName : undefined
  return plainName === undefined || plainName === true
    ? { sessionId: value.sessionId, ...(plainName ? { plainName } : {}) }
    : undefined
}

/** A frame's whole naming state, or null when the frame says nothing about naming. A current host
 *  sends `forkedFrom` (object or null) on every frame for a record, which makes the frame
 *  authoritative even while the chat is unnamed; an older host's frame counts only with a name. */
function readNamingNote(value: unknown): AgentSessionConversationName | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  if (!('sessionId' in value) || typeof value.sessionId !== 'string' || !value.sessionId) {
    return null
  }
  const forkedFrom = 'forkedFrom' in value ? readForkNaming(value.forkedFrom) : undefined
  const named = 'conversationName' in value
  if (!named && forkedFrom === undefined) {
    return null
  }
  const rawName = named ? value.conversationName : null
  if (rawName !== null && rawName !== undefined && !isAgentSessionConversationName(rawName)) {
    return null
  }
  const name = isAgentSessionConversationName(rawName) ? rawName : null
  const namingError = readNamingError('namingError' in value ? value.namingError : undefined)
  if (namingError === false) {
    return null
  }
  return {
    sessionId: value.sessionId,
    conversationName: name,
    ...(namingError ? { namingError } : {}),
    // Provenance only from a frame that also says whether the chat is a fork.
    ...(forkedFrom !== undefined
      ? {
          forkedFrom,
          ...('conversationNameSource' in value && value.conversationNameSource === 'user'
            ? { conversationNameSource: 'user' as const }
            : {})
        }
      : {})
  }
}

function sameNamingNote(
  a: AgentSessionConversationName | undefined,
  b: AgentSessionConversationName
): boolean {
  return (
    a !== undefined &&
    a.conversationName === b.conversationName &&
    a.namingError?.message === b.namingError?.message &&
    a.namingError?.failedAt === b.namingError?.failedAt &&
    a.conversationNameSource === b.conversationNameSource &&
    'forkedFrom' in a === 'forkedFrom' in b &&
    agentSessionForkNamingEqual(a.forkedFrom, b.forkedFrom)
  )
}

/** Stream order is title order; metadata never asserts a turn or live observation. Each frame
 *  replaces its chat's entry whole, so an older host's frame leaves no stale fork mark behind. */
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
  for (const frame of [...sessions, ...notes]) {
    const note = readNamingNote(frame)
    if (!note || sameNamingNote((next ?? names).get(note.sessionId), note)) {
      continue
    }
    next ??= new Map(names)
    next.set(note.sessionId, note)
  }
  return next ?? names
}
