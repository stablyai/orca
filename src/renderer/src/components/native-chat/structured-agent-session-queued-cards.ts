// What the queued-message cards above the composer show, derived per publish —
// the wire carries no hold label (§ labels are client policy, not host state).

import type { UnreadAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../../shared/agent-session-wire'
import {
  readAgentMessageSource,
  type AgentMessageSource
} from '../../../../shared/agent-session-message-source'
import { handedOffQueuedMessageIds } from '../../../../shared/structured-agent-session-draft-hand-off'

/** Why a card is not on its way right now; decides the caption under the text. */
export type QueuedMessageCardHold =
  | 'turn'
  /** The whole queue is paused: the header row says why and offers Resume, so the card makes
   *  no promise about when it sends — not even after an answer, which does not drain it. */
  | 'queue-paused'
  | 'awaiting-answer'
  | 'paused'
  | 'behind-returned'
  | 'returned'

export type QueuedMessageCard = {
  messageId: string
  position: number
  /** The draft's text blocks joined; drafts are text-only in v1. */
  text: string
  state: 'waiting' | 'returned'
  hold: QueuedMessageCardHold
  pausedReason?: string
  returnedReason?: string | null
  /** The typed fact the returned card's submission settled with; read like its `rejection`. */
  returnedRejection?: UnreadAgentSessionFailureFact
  /** Another agent's card: who sent it. */
  from?: AgentMessageSource
}

function queuedMessageCardText(body: AgentSessionQueuedMessage['body']): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/**
 * Cards in queue order. A waiting card is hidden once a submission hands it off
 * (`queuedMessageId`) and that hand-off is live: on a multi-page catch-up the shrunk
 * list rides only the final page, so the bubble and the card would otherwise briefly
 * coexist. A rejected hand-off is exactly what sent the draft back, so it hides
 * nothing. Presentation only — no durable state. Returned cards never hide.
 */
export function projectQueuedMessageCards(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined,
  submissions: readonly AgentJournalSubmission[],
  session: { hasPendingPrompt: boolean; queuePaused?: boolean }
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
              : session.hasPendingPrompt
                ? 'awaiting-answer'
                : 'turn'
    behindReturned = behindReturned || message.state === 'returned'
    const from = readAgentMessageSource(message.body.from)
    return {
      messageId: message.messageId,
      position: message.position,
      text: queuedMessageCardText(message.body),
      state: message.state,
      hold,
      ...(message.pausedReason !== undefined ? { pausedReason: message.pausedReason } : {}),
      ...(message.returnedReason !== undefined ? { returnedReason: message.returnedReason } : {}),
      ...(message.returnedRejection !== undefined
        ? { returnedRejection: message.returnedRejection }
        : {}),
      ...(from ? { from } : {})
    }
  })
}

/** The pause the header row names, while it holds a card. A pause over cards Resume would not
 *  send (returned, held on their own, or behind a returned one) offers nothing to press. */
export function queuedMessagesQueuePause(
  cards: readonly QueuedMessageCard[],
  queuePause: AgentSessionQueuePause | null
): AgentSessionQueuePause | null {
  return cards.some((card) => card.hold === 'queue-paused') ? queuePause : null
}

/** Steer names the mid-turn jump, also while the whole queue is paused; a card held on its own or
 *  returned is not waiting on the turn, so its action is plainly Send. */
export function queuedMessageCardSteers(card: QueuedMessageCard): boolean {
  return card.hold !== 'paused' && card.hold !== 'returned'
}

/** The card Cmd/Ctrl+Enter steers: the newest one; every shown card takes Send-now. */
export function newestSteerableQueuedMessageCard(
  cards: readonly QueuedMessageCard[]
): QueuedMessageCard | null {
  return cards.at(-1) ?? null
}

/**
 * The sends the transcript draws as pending bubbles. One the host holds as a card (same id) is a
 * card, and so is one asking to be queued while the agent works, which would otherwise paint in the
 * transcript until its card appears. A recorded one stays drawn until its row arrives.
 */
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
