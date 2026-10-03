// The queued-message part of the agent-session wire: the published draft cards,
// the queue's pause beside them, and the draft mutations' answers.

import type { UnreadAgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalMessageItem } from './agent-session-journal-types'

/** The draft could not be converted into a send; an explicit Send retries it. */
export const QUEUED_MESSAGE_PAUSED_SEND_FAILED = 'send_failed' as const

/** A person's message the host accepted and never handed over before a restart or a close of the
 *  chat. It waits for the person's own Send; the cards behind it still send, as past a failed one. */
export const QUEUED_MESSAGE_PAUSED_KEPT = 'kept' as const

export type AgentSessionQueuedMessagePausedReason =
  | typeof QUEUED_MESSAGE_PAUSED_SEND_FAILED
  | typeof QUEUED_MESSAGE_PAUSED_KEPT

/** The whole queue is paused and sends nothing on its own: 'stopped' — the user
 *  interrupted ("Queue paused because you interrupted") — 'cleared' — a /clear
 *  carried the cards into a fresh conversation — or 'restarted' — Orca restarted
 *  with cards waiting. Resume (`agentSession.queuedMessagesResume`), or the user's own next
 *  turn starting, lifts it; Send-now on one card sends that card and leaves the
 *  rest paused until its turn starts. A client treats an unknown reason as a
 *  plain pause, so a newer host can add one. */
export type AgentSessionQueuePause = { reason: 'stopped' | 'restarted' | 'cleared' }

export type AgentSessionQueuedMessagesResumeResult = {
  /** False when nothing was paused, and on a replay of an already-run Resume. */
  resumed: boolean
}

/** One draft the host holds for this conversation, published whole-list on the
 *  subscribe stream and on history pages. Text-only v1. */
export type AgentSessionQueuedMessage = {
  messageId: string
  position: number
  body: AgentJournalMessageItem
  state: 'waiting' | 'returned'
  /** This one card is held, whatever the queue's pause: its conversion failed, or the host kept it. */
  paused?: true
  /** Why it is held, as a marker the client localizes: 'send_failed' ("couldn't
   *  send") or 'kept' (accepted, never sent); only an explicit Send releases either. A client
   *  must treat an unknown marker as a plain hold, so a newer host can add one. The queue-level
   *  pause is `queuePause`, published beside the list. */
  pausedReason?: AgentSessionQueuedMessagePausedReason
  /** A returned card's refusal: the `reason` and `rejection` pair its submission settled with.
   *  Only a failure returns a card; a draft a Stop or restart took back waits again. Clients classify it from `returnedRejection` (falling back to `returnedReason` when a host
   *  wrote no fact) exactly as they classify a rejected submission's `rejection`, e.g.
   *  `classifyDispatchRejection({ reason: returnedReason, rejection: returnedRejection })`. */
  returnedReason?: string | null
  returnedRejection?: UnreadAgentSessionFailureFact
}

/** No body: the card leaving the published list IS the outcome, so a lost
 *  answer needs no re-ask and no text ever rides the wire back. */
export type AgentSessionQueuedMessageDeleteResult =
  | { deleted: true; messageId: string }
  /** `dispatched` means it already became a submission; `missing` covers a
   *  pruned tombstone. Replays answer from tombstone receipts. */
  | { deleted: false; messageId: string; disposition: 'dispatched' | 'withdrawn' | 'missing' }
