import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { readAgentMessageSource } from '../journal/agent-session-message-source'
import type { AgentSessionQueuedMessage } from '../requests/agent-session-queued-message-wire'
import type { NativeChatMessage } from '../../native-chat/native-chat-types'
import { nativeChatMessageSenderFields } from '../../native-chat-message-sender-fields'
import { structuralValuesEqual } from '../../collections/structural-value-equality'
import { handedOffQueuedMessageIds } from './structured-agent-session-draft-hand-off'

/** Another agent's message waiting its turn: drawn after the chat's live activity in its delivered
 *  shape. One that failed to send or came back stays a card, where its caption says why. */
export function queuedMessageIsWaitingAgentMail(message: AgentSessionQueuedMessage): boolean {
  return (
    message.state === 'waiting' &&
    !message.paused &&
    message.body.command === undefined &&
    readAgentMessageSource(message.body.from) !== undefined
  )
}

function waitingAgentMailRow(message: AgentSessionQueuedMessage): NativeChatMessage {
  return {
    id: agentJournalSubmissionKey(message.messageId),
    role: 'user',
    source: 'transcript',
    timestamp: null,
    blocks: message.body.blocks,
    ...nativeChatMessageSenderFields(message.body, 'user'),
    queued: true,
    queuedMessageId: message.messageId
  }
}

/** One chat's waiting agent mail as rows, in queue order, until its hand-off's own row replaces it.
 *  While the mail is unchanged it returns the previous rows, so other queue changes redraw nothing. */
export function createWaitingAgentMailRows(): (
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined,
  submissions: readonly AgentJournalSubmission[]
) => readonly NativeChatMessage[] {
  let previous: { messages: AgentSessionQueuedMessage[]; rows: readonly NativeChatMessage[] } = {
    messages: [],
    rows: []
  }
  return (queuedMessages, submissions) => {
    const waiting = (queuedMessages ?? []).filter(queuedMessageIsWaitingAgentMail)
    const handedOff =
      waiting.length > 0
        ? handedOffQueuedMessageIds(
            submissions.filter((submission) => submission.dispatchState !== 'rejected')
          )
        : new Set<string>()
    const messages = waiting
      .filter((message) => !handedOff.has(message.messageId))
      .sort((left, right) => left.position - right.position)
    const same =
      messages.length === previous.messages.length &&
      messages.every((message, index) => {
        const before = previous.messages[index]!
        return (
          message.messageId === before.messageId && structuralValuesEqual(message.body, before.body)
        )
      })
    if (!same) {
      previous = { messages, rows: messages.map(waitingAgentMailRow) }
    }
    return previous.rows
  }
}

/** The composer queue's cards: waiting agent mail is drawn in the transcript instead, unless it is
 *  being edited, which happens in the queue's editor; its transcript row steps aside meanwhile. */
export function composerQueuedCards<Card extends { messageId: string }>(
  cards: readonly Card[],
  agentMail: readonly NativeChatMessage[],
  editingId: string | undefined
): { cards: Card[]; agentMail: readonly NativeChatMessage[]; mailLeads: boolean } {
  if (agentMail.length === 0) {
    return { cards: [...cards], agentMail, mailLeads: false }
  }
  const waiting = new Set(agentMail.map((row) => row.queuedMessageId))
  const composer = cards.filter(
    (card) => !waiting.has(card.messageId) || card.messageId === editingId
  )
  const head = cards[0]
  return {
    cards: composer,
    agentMail:
      editingId !== undefined && waiting.has(editingId)
        ? agentMail.filter((row) => row.queuedMessageId !== editingId)
        : agentMail,
    // The queue's head is mail the transcript draws, which the steer shortcut still presses first.
    mailLeads: head !== undefined && head.messageId !== editingId && waiting.has(head.messageId)
  }
}
