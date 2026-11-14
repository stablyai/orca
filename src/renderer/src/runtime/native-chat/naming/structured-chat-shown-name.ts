import {
  agentSessionForkSourceSavedName,
  agentSessionShownName
} from '../../../../../shared/agent-session/agent-session-fork-name'
import type { AgentSessionConversationName } from '../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionStatusFeedOwner } from '../status/structured-agent-session-status-feed'

type NamingFeed = Pick<StructuredAgentSessionStatusFeedOwner, 'getNamingSnapshot' | 'getSnapshot'>

/** Whether this chat's shown name can depend on its source's saved name (an older fork's title). */
export function structuredChatNameReadsSource(
  note: AgentSessionConversationName | undefined
): string | null {
  const forkedFrom = note?.forkedFrom
  return forkedFrom && !forkedFrom.plainName && note.conversationNameSource !== 'user'
    ? forkedFrom.sessionId
    : null
}

/** The source's saved name as an older fork was titled from it; undefined while unknown here. */
export function structuredChatForkSourceSavedName(
  feed: NamingFeed,
  note: AgentSessionConversationName | undefined
): string | undefined {
  const sourceId = structuredChatNameReadsSource(note)
  const source = sourceId ? feed.getNamingSnapshot().get(sourceId) : undefined
  if (!sourceId || !source) {
    return undefined
  }
  if (source.conversationName?.trim()) {
    return source.conversationName.trim()
  }
  // Read only the source's own summary, so the source subscription is the one that wakes this.
  const agent = feed.getSnapshot().get(sourceId)?.agent
  return agent ? agentSessionForkSourceSavedName(source, agent) : undefined
}

/** A chat's shown name from its host's feed as it stands now; null while unnamed. */
export function structuredChatShownName(feed: NamingFeed, sessionId: string): string | null {
  const note = feed.getNamingSnapshot().get(sessionId)
  return note ? agentSessionShownName(note, structuredChatForkSourceSavedName(feed, note)) : null
}

/** The chat this one was forked from, as its host last said; null when not a fork or unknown. */
export function structuredChatForkSourceId(
  note: AgentSessionConversationName | undefined
): string | null {
  return note?.forkedFrom?.sessionId ?? null
}
