// "Fork from this response", decided the same way on desktop and phone.

import type { AgentSessionCapabilities } from '../agent-session/agent-session-capabilities'
import type { StructuredAgentSessionHostCapabilityState } from '../agent-session/structured-agent-session-host-capability'
import { isRootAgentJournalItem } from '../agent-session/journal/agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../agent-session/view/structured-agent-session-message-projection'
import type { NativeChatTurnJournal } from './transcript/native-chat-turn-membership'
import type { AgentSessionOptionsResult } from '../agent-session/options/agent-session-options-result'
import { AGENT_SESSION_FORKED_FROM_PRESENTATION } from '../agent-session/agent-session-fork'
import { nativeChatTurnMembership } from './transcript/native-chat-turn-membership'
import type { NativeChatMessage } from './native-chat-types'

/** What a chat can fork: nothing, not yet known (drawn disabled), or through which turns. */
export type NativeChatForkSupport =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | {
      kind: 'known'
      fork: NonNullable<AgentSessionCapabilities['fork']>
      inheritedOriginal?: boolean
    }

/** `agent` is the host's registered row for the chat's agent: undefined until the host has listed it.
 *  `session` is the chat's options answer about its installed agent; absent until that read lands. */
export function nativeChatForkSupport(
  host: StructuredAgentSessionHostCapabilityState,
  agent: { capabilities: Pick<AgentSessionCapabilities, 'fork'> } | undefined,
  session: AgentSessionOptionsResult['forkSupport'],
  inheritedOriginal: StructuredAgentSessionHostCapabilityState = 'unknown'
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
    ? { kind: 'known', fork, inheritedOriginal: inheritedOriginal === 'supported' }
    : { kind: 'unknown' }
}

/** The journal rows a fork can go through: the chat's own agent's messages. A displayed row that only
 *  reads as a response (a tool call, or a status projected as a plan) maps to none of them. */
export function nativeChatForkInventory(
  items: readonly Pick<AgentJournalRenderItem, 'itemId' | 'body' | 'agentId' | 'sequence'>[]
): { forkableItemIds: ReadonlySet<string>; inheritedThroughSequence: number } {
  const forkableItemIds = new Set<string>()
  let inheritedThroughSequence = 0
  for (const item of items) {
    if (
      item.body.kind === 'status' &&
      item.body.presentation === AGENT_SESSION_FORKED_FROM_PRESENTATION
    ) {
      inheritedThroughSequence = item.sequence
    }
    if (
      item.body.kind === 'message' &&
      item.body.role === 'assistant' &&
      isRootAgentJournalItem(item)
    ) {
      forkableItemIds.add(item.itemId)
    }
  }
  return { forkableItemIds, inheritedThroughSequence }
}

/** The response `/fork` copies through: the chat's newest forkable one still in its current context. */
export function nativeChatLatestForkItemId(
  items: readonly Pick<AgentJournalRenderItem, 'itemId' | 'sequence'>[],
  chat: { contextFloorSequence: number; forkableItemIds: ReadonlySet<string> }
): string | undefined {
  let latest: Pick<AgentJournalRenderItem, 'itemId' | 'sequence'> | undefined
  for (const item of items) {
    if (
      chat.forkableItemIds.has(item.itemId) &&
      item.sequence > chat.contextFloorSequence &&
      (!latest || item.sequence >= latest.sequence)
    ) {
      latest = item
    }
  }
  return latest?.itemId
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
    inheritedThroughSequence?: number
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
    (chat.support.kind === 'unknown' ||
      chat.support.fork === 'checkpoint' ||
      row.inLatestTurn ||
      (chat.support.inheritedOriginal === true && sequence <= (chat.inheritedThroughSequence ?? 0)))
  )
}

/** Nonlatest copied replies of tip-only agents need the host's original-resolution extension. */
export function nativeChatForkRequiresInheritedOriginal(
  items: readonly AgentJournalRenderItem[],
  fork: 'tip' | 'checkpoint',
  throughItemId: string,
  journal: Omit<NativeChatTurnJournal, 'items'> = { submissions: [] }
): boolean {
  if (fork !== 'tip') {
    return false
  }
  const selected = items.find((item) => item.itemId === throughItemId)
  if (!selected || selected.sequence > nativeChatForkInventory(items).inheritedThroughSequence) {
    return false
  }
  const messages = projectStructuredAgentSessionMessages(items, [], journal.submissions).filter(
    isRootAgentJournalItem
  )
  const { turnKeys } = nativeChatTurnMembership(messages, { ...journal, items })
  const selectedTurn = turnKeys[messages.findIndex((message) => message.id === throughItemId)]
  return (
    selectedTurn === undefined || selectedTurn !== turnKeys.findLast((key) => key !== undefined)
  )
}
