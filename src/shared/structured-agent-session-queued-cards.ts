// Derive hold labels on the client; the wire carries queue state, not presentation wording.

import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact,
  type UnreadAgentSessionFailureFact
} from './agent-session-failure'
import { agentSessionFailureStatedByRow } from './agent-session-visible-failures'
import { agentSessionWriteNotDoneParts } from './agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from './agent-session-write-notice-copy'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import { structuredAgentSessionAttemptFailureParts } from './structured-agent-session-rejection-words'
import type { AgentJournalItemBody, AgentJournalSubmission } from './agent-session-journal-types'
import { pendingPromptsAllUnanswerableHere } from './agent-session-approval-subject'
import type { NativeChatImageRefBlock } from './native-chat-types'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionQueuePause
} from './agent-session-wire'
import {
  readAgentMessageSource,
  type AgentMessageSource
} from './agent-session/agent-session-message-source'
import { handedOffQueuedMessageIds } from './structured-agent-session-draft-hand-off'
import {
  NATIVE_CHAT_IMAGE_LABEL_ENGLISH,
  nativeChatImageLabel,
  type NativeChatImageLabelCopy
} from './native-chat-image-label'

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

export function queuedMessageCardText(body: AgentSessionQueuedMessage['body']): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

export function queuedMessageCardImages(
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
function commandCardWaiting(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined
): boolean {
  return (queuedMessages ?? []).some(
    (message) =>
      message.state === 'waiting' && !message.paused && message.body.command !== undefined
  )
}

/** Sends queue behind a waiting command even with follow-ups off; prompts no one here can answer would strand the queue, so then a send starts a turn. */
export function structuredAgentSessionQueueEnabled(
  queueFollowUps: boolean,
  session: { queuedMessages?: readonly AgentSessionQueuedMessage[] | null },
  prompts: readonly { body: AgentJournalItemBody }[]
): boolean {
  return (
    (queueFollowUps || commandCardWaiting(session.queuedMessages)) &&
    !pendingPromptsAllUnanswerableHere(prompts)
  )
}

/** A returned card, or one whose own send failed, needs the person; the rest wait their turn. */
export function queuedMessageCardNeedsAttention(
  card: Pick<QueuedMessageCard, 'state' | 'pausedReason'>
): boolean {
  return card.state === 'returned' || card.pausedReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED
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

/** The card's line: its text, or for a card of images alone, the image's name or their count. */
export function queuedMessageCardLine(
  card: Pick<QueuedMessageCard, 'text' | 'images'>,
  copy: NativeChatImageLabelCopy = NATIVE_CHAT_IMAGE_LABEL_ENGLISH
): string {
  const images = card.images ?? []
  if (card.text.trim() || images.length === 0) {
    return card.text
  }
  return images.length === 1
    ? nativeChatImageLabel(images[0], copy)
    : copy.imageCount(images.length)
}

/** A returned card's words: a Stop withdrawal is not a send failure; the card's own Send is the retry, so failure words leave sending again out. */
export function queuedMessageReturnedNotice(
  card: Pick<QueuedMessageCard, 'returnedReason' | 'returnedRejection'>,
  agentName: string | undefined,
  statedFailures: readonly AgentSessionFailureFact[]
): 'withdrawn' | AgentSessionWriteNoticePart[] {
  // Read exactly as a rejected submission: the typed fact decides, the reason is the fallback.
  const reason = card.returnedReason ?? null
  const rejection = card.returnedRejection
  if (agentSessionFailureStatedByRow(rejection, statedFailures)) {
    return agentSessionWriteNotDoneParts('send')
  }
  if (dispatchWasWithdrawn({ dispatchState: 'rejected', reason, rejection })) {
    return 'withdrawn'
  }
  return structuredAgentSessionAttemptFailureParts(
    { kind: 'rejected', reason },
    { agentName, retryControl: true },
    readWholeAgentSessionFailureFact(rejection)
  )
}
