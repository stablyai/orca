// Derive hold labels on the client; the wire carries queue state, not presentation wording.

import type { UnreadAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { NativeChatImageRefBlock } from '../../../../shared/native-chat-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../../shared/agent-session-wire'
import {
  readAgentMessageSource,
  type AgentMessageSource
} from '../../../../shared/agent-session/agent-session-message-source'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import { handedOffQueuedMessageIds } from '../../../../shared/structured-agent-session-draft-hand-off'

export type QueuedMessageCardHold =
  /** Plainly queued, also behind an open question: the question already says the agent waits. */
  | 'turn'
  /** The header owns queue-wide pause wording; answering a prompt does not resume draining. */
  | 'queue-paused'
  | 'paused'
  | 'behind-returned'
  | 'returned'
  /** Disable actions until the host replaces this sending card under the same id. */
  | 'sending'

export type QueuedMessageCard = {
  messageId: string
  position: number
  text: string
  /** The draft's images, which an edit of its text keeps. */
  images?: readonly NativeChatImageRefBlock[]
  state: 'waiting' | 'returned'
  hold: QueuedMessageCardHold
  /** A conversation command such as /compact: it never steers into a running turn. */
  command?: true
  /** A command card while the agent works: it offers no send until the agent is idle. */
  waitsForAgent?: true
  pausedReason?: string
  returnedReason?: string | null
  /** The typed fact the returned card's submission settled with; read like its `rejection`. */
  returnedRejection?: UnreadAgentSessionFailureFact
  from?: AgentMessageSource
}

function queuedMessageCardText(body: AgentSessionQueuedMessage['body']): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function queuedMessageCardImages(
  body: AgentSessionQueuedMessage['body']
): Pick<QueuedMessageCard, 'images'> {
  const images = body.blocks.flatMap((block) => (block.type === 'image-ref' ? [block] : []))
  return images.length > 0 ? { images } : {}
}

/** Hide waiting cards after live submission hand-off to avoid catch-up duplicates; rejected hand-offs restore cards, and returned cards never hide. */
export function projectQueuedMessageCards(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined,
  submissions: readonly AgentJournalSubmission[],
  session: { queuePaused?: boolean; agentWorking?: boolean }
): QueuedMessageCard[] {
  const handedOff = handedOffQueuedMessageIds(
    submissions.filter((submission) => submission.dispatchState !== 'rejected')
  )
  const ordered = [...(queuedMessages ?? [])]
    .sort((left, right) => left.position - right.position)
    .filter((message) => message.state === 'returned' || !handedOff.has(message.messageId))
  let behindReturned = false
  return ordered.map((message) => {
    const hold: QueuedMessageCardHold =
      message.state === 'returned'
        ? 'returned'
        : message.paused
          ? 'paused'
          : behindReturned
            ? 'behind-returned'
            : session.queuePaused
              ? 'queue-paused'
              : 'turn'
    behindReturned = behindReturned || message.state === 'returned'
    const from = readAgentMessageSource(message.body.from)
    return {
      messageId: message.messageId,
      position: message.position,
      text: queuedMessageCardText(message.body),
      ...queuedMessageCardImages(message.body),
      state: message.state,
      hold,
      ...(message.body.command !== undefined
        ? {
            command: true as const,
            ...(session.agentWorking ? { waitsForAgent: true as const } : {})
          }
        : {}),
      ...(message.pausedReason !== undefined ? { pausedReason: message.pausedReason } : {}),
      ...(message.returnedReason !== undefined ? { returnedReason: message.returnedReason } : {}),
      ...(message.returnedRejection !== undefined
        ? { returnedRejection: message.returnedRejection }
        : {}),
      ...(from ? { from } : {})
    }
  })
}

/** Later sends queue behind commands even with follow-ups off; individually held cards do not block them. */
export function commandCardWaiting(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined
): boolean {
  return (queuedMessages ?? []).some(
    (message) =>
      message.state === 'waiting' && !message.paused && message.body.command !== undefined
  )
}

/** Offer Resume only while the queue pause holds a card it could actually send. */
export function queuedMessagesQueuePause(
  cards: readonly QueuedMessageCard[],
  queuePause: AgentSessionQueuePause | null
): AgentSessionQueuePause | null {
  return cards.some((card) => card.hold === 'queue-paused') ? queuePause : null
}

/** Steer moves turn-waiting cards mid-turn, even during queue pause; returned/individually held cards use Send, commands never steer. */
export function queuedMessageCardSteers(card: QueuedMessageCard): boolean {
  return card.hold !== 'paused' && card.hold !== 'returned' && !card.command
}

/** The card Cmd/Ctrl+Enter steers: the newest one, unless it is a command, which never steers. */
export function newestSteerableQueuedMessageCard(
  cards: readonly QueuedMessageCard[]
): QueuedMessageCard | null {
  const newest = cards.at(-1)
  return newest && !newest.command && newest.hold !== 'sending' ? newest : null
}

export function sendingQueuedMessageCards(
  entries: readonly StructuredAgentSessionPendingSend[]
): QueuedMessageCard[] {
  return entries.map((entry, index) => ({
    messageId: entry.clientMessageId,
    // After every card the host holds, in send order.
    position: Number.MAX_SAFE_INTEGER - entries.length + index,
    text: queuedMessageCardText(entry.body),
    ...queuedMessageCardImages(entry.body),
    state: 'waiting',
    hold: 'sending'
  }))
}

/** Host-owned cards and active queue requests stay out of transcript echoes; recorded sends remain until their row arrives. */
export function pendingSendsOutsideQueuedCards<
  Send extends { clientMessageId: string; delivery?: 'queue-if-active' }
>(pending: readonly Send[], heldIds: readonly string[], isWorking: boolean): readonly Send[] {
  const held = new Set(heldIds)
  const next = pending.filter(
    (entry) =>
      !held.has(entry.clientMessageId) && !(isWorking && entry.delivery === 'queue-if-active')
  )
  return next.length === pending.length ? pending : next
}

export function pendingQueueSendsOnTheirWay(
  pending: readonly StructuredAgentSessionPendingSend[],
  heldIds: readonly string[],
  isWorking: boolean,
  submissions: readonly AgentJournalSubmission[]
): StructuredAgentSessionPendingSend[] {
  if (!isWorking) {
    return []
  }
  const recorded = new Set([
    ...heldIds,
    ...handedOffQueuedMessageIds(submissions),
    ...submissions.map((submission) => submission.clientMessageId)
  ])
  return pending.filter(
    (entry) =>
      entry.phase === 'sending' &&
      entry.delivery === 'queue-if-active' &&
      !recorded.has(entry.clientMessageId)
  )
}
