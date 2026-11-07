// "Fork from this response", decided the same way on desktop and phone.

import type { AgentSessionCapabilities } from '../agent-session/agent-session-capabilities'
import type { StructuredAgentSessionHostCapabilityState } from '../agent-session/structured-agent-session-host-capability'
import { isRootAgentJournalItem } from '../agent-session/journal/agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../agent-session/options/agent-session-options-result'
import type { NativeChatMessage } from './native-chat-types'
import {
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from './transcript/native-chat-turn-membership'

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
 *  the end of that response's turn, so any of its responses can fork it: the phone offers each one,
 *  the desktop the turn's last words, where its response actions sit. */
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

/** Where a side chat forks: the newest response "Fork from this response" offers, or why none is. */
export type NativeChatLatestForkPoint =
  | { kind: 'ready'; throughItemId: string }
  | { kind: 'reply-running' }
  | { kind: 'no-reply' }

export function nativeChatLatestForkPoint(
  conversation: {
    messages: readonly NativeChatMessage[]
    journal: NativeChatTurnJournal | null
    agentWorking: boolean
  },
  chat: Parameters<typeof nativeChatRowOffersFork>[1]
): NativeChatLatestForkPoint {
  const { messages, journal, agentWorking } = conversation
  const { turnKeys, liveTurnKey } = nativeChatTurnMembership(messages, journal)
  const latestTurnKey = turnKeys.findLast((key) => key !== undefined)
  for (let index = messages.length - 1; index >= 0; index--) {
    const turnKey = turnKeys[index]
    const offered = nativeChatRowOffersFork(
      {
        message: messages[index],
        inSubagentSection: false,
        turnWorking: agentWorking && (turnKey === undefined || turnKey === liveTurnKey),
        inLatestTurn: turnKey !== undefined && turnKey === latestTurnKey
      },
      chat
    )
    if (offered) {
      return { kind: 'ready', throughItemId: messages[index].id }
    }
  }
  return agentWorking ? { kind: 'reply-running' } : { kind: 'no-reply' }
}
