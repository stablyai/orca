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
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
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
  /** On its way to the host, which holds no card for it yet: it reads as sending, and nothing
   *  can act on it until the host's card replaces it under the same id. */
  | 'sending'

export type QueuedMessageCard = {
  messageId: string
  position: number
  /** The draft's text blocks joined; drafts are text-only in v1. */
  text: string
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
  session: { hasPendingPrompt: boolean; queuePaused?: boolean; agentWorking?: boolean }
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

/** A command card waits in line: a later send goes behind it, even with follow-ups off. A card
 *  held on its own (kept, couldn't send) is skipped by the queue, so nothing is behind it. */
export function commandCardWaiting(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined
): boolean {
  return (queuedMessages ?? []).some(
    (message) =>
      message.state === 'waiting' && !message.paused && message.body.command !== undefined
  )
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
 *  returned is not waiting on the turn, so its action is plainly Send. A command never steers. */
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

/** A queue send still on its way, as the card it is about to become. */
export function sendingQueuedMessageCards(
  entries: readonly StructuredAgentSessionPendingSend[]
): QueuedMessageCard[] {
  return entries.map((entry, index) => ({
    messageId: entry.clientMessageId,
    // After every card the host holds, in send order.
    position: Number.MAX_SAFE_INTEGER - entries.length + index,
    text: queuedMessageCardText(entry.body),
    state: 'waiting',
    hold: 'sending'
  }))
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

/** Queue sends without a host card or submission yet, drawn as sending cards. */
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
