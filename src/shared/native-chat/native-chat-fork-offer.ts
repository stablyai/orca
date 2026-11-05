// "Fork from this response", decided the same way on desktop and phone.

import type { AgentSessionCapabilities } from '../agent-session/agent-session-capabilities'
import type { StructuredAgentSessionHostCapabilityState } from '../agent-session/structured-agent-session-host-capability'
import { isRootAgentJournalItem } from '../agent-session/journal/agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../agent-session/options/agent-session-options-result'
import type { NativeChatMessage } from './native-chat-types'

/** What a chat can fork: nothing, not yet known (drawn disabled), or through which turns. */
export type NativeChatForkSupport =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'known'; fork: NonNullable<AgentSessionCapabilities['fork']> }

/** `agent` is the host's registered row for the chat's agent: undefined until the host has listed it.
 *  `session` is the chat's options answer about its installed agent; absent until that read lands. */
export function nativeChatForkSupport(
  host: StructuredAgentSessionHostCapabilityState,
  agent: { capabilities: Pick<AgentSessionCapabilities, 'fork'> } | undefined,
  session: AgentSessionOptionsResult['forkSupport']
): NativeChatForkSupport {
  const fork = agent?.capabilities.fork
  if (
    host === 'unsupported' ||
    (agent && fork !== 'checkpoint' && fork !== 'tip') ||
    session === 'unsupported'
  ) {
    return { kind: 'none' }
  }
  return host === 'supported' && fork && session === 'supported'
    ? { kind: 'known', fork }
    : { kind: 'unknown' }
}

/** The journal rows a fork can go through: the chat's own agent's messages. A displayed row that only
 *  reads as a response (a tool call, or a status projected as a plan) maps to none of them. */
export function nativeChatForkableItemIds(
  items: readonly Pick<AgentJournalRenderItem, 'itemId' | 'body' | 'agentId'>[]
): ReadonlySet<string> {
  return new Set(
    items
      .filter(
        (item) =>
          item.body.kind === 'message' &&
          item.body.role === 'assistant' &&
          isRootAgentJournalItem(item)
      )
      .map((item) => item.itemId)
  )
}

/** A finished response of the chat's own agent, still in its current context. A fork copies through
 *  the end of that response's turn, so any of the turn's responses offers it, not only its last. */
export function nativeChatRowOffersFork(
  row: {
    message: NativeChatMessage
    /** Inside a subagent's section, whose replies are no root turn. */
    inSubagentSection: boolean
    turnWorking: boolean
    /** The row belongs to the conversation's newest turn. */
    inLatestTurn: boolean
  },
  chat: {
    support: NativeChatForkSupport
    contextFloorSequence: number
    forkableItemIds: ReadonlySet<string>
  }
): boolean {
  const { message } = row
  const sequence = message.journalPosition?.sequence
  return (
    chat.support.kind !== 'none' &&
    message.role === 'assistant' &&
    chat.forkableItemIds.has(message.id) &&
    message.source === 'transcript' &&
    !message.agentStart &&
    !row.inSubagentSection &&
    isRootAgentJournalItem(message) &&
    !row.turnWorking &&
    // Rows above a /clear are no longer in the agent's context.
    sequence !== undefined &&
    sequence > chat.contextFloorSequence &&
    (chat.support.kind === 'unknown' || chat.support.fork === 'checkpoint' || row.inLatestTurn)
  )
}
