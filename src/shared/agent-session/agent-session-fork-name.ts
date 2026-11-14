import type { AgentType } from '../agent-status/contracts/agent-status-types'
import { defaultAgentChatLabel } from './agent-session-chat-label'
import {
  AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH,
  normalizeAgentSessionConversationName
} from './agent-session-conversation-name'
import { sliceAtCodeUnitLimit } from '../surrogate-safe-text-slice'

/** A chat's fork ancestry as naming frames carry it. `plainName` marks a fork saved under its
 *  source's name; older forks were saved as "<source> fork". */
export type AgentSessionForkNaming = { sessionId: string; plainName?: true }

/** The "Forked from" row's link: the source, whether it is itself a fork, and whether this host
 *  has no readable record of it (then the row names no chat to open). */
export type AgentSessionForkedFromMark = {
  sessionId: string
  sourceForked?: true
  sourceMissing?: true
}

export type AgentSessionForkNameFacts = {
  conversationName?: string | null
  conversationNameSource?: 'user'
  forkedFrom?: AgentSessionForkNaming | null
}

/** What a source's chat is called before its own name exists, as old forks titled it. */
export function agentSessionForkSourceSavedName(
  source: { conversationName?: string | null },
  agent: AgentType | null | undefined
): string {
  return source.conversationName?.trim() || defaultAgentChatLabel(agent)
}

// The title older builds gave a fork, reproduced so only that exact text is ever trimmed.
function legacyForkTitle(sourceSavedName: string): string | null {
  return normalizeAgentSessionConversationName(
    `${sliceAtCodeUnitLimit(sourceSavedName, AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH - 5)} fork`
  )
}

/**
 * A chat's shown name. The fork mark comes from `forkedFrom`, so an older fork drops the " fork"
 * its build appended, but only while its name is exactly that build's title for the source's saved
 * name: user names, plain-named forks, and names the source has since moved away from stay as saved.
 */
export function agentSessionShownName(
  chat: AgentSessionForkNameFacts,
  sourceSavedName: string | undefined
): string | null {
  const name = chat.conversationName ?? null
  if (
    name === null ||
    !chat.forkedFrom ||
    chat.forkedFrom.plainName ||
    chat.conversationNameSource === 'user' ||
    sourceSavedName === undefined
  ) {
    return name
  }
  return legacyForkTitle(sourceSavedName) === name ? sourceSavedName : name
}

export function agentSessionForkNamingEqual(
  a: AgentSessionForkNaming | null | undefined,
  b: AgentSessionForkNaming | null | undefined
): boolean {
  return a === b || (!!a && !!b && a.sessionId === b.sessionId && a.plainName === b.plainName)
}
