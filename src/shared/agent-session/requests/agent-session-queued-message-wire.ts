// Publish queued cards, queue pause and draft mutation results together.

import type { UnreadAgentSessionFailureFact } from '../failures/agent-session-failure'
import type { AgentJournalMessageItem } from '../journal/agent-session-journal-types'

/** The draft could not be converted into a send; an explicit Send retries it. */
export const QUEUED_MESSAGE_PAUSED_SEND_FAILED = 'send_failed' as const

export type AgentSessionQueuedMessagePausedReason =
  | typeof QUEUED_MESSAGE_PAUSED_SEND_FAILED
  | 'restarted'

/** Stop/failure pauses offer Resume; reopen-held steers publish a per-card pause instead. */
export type AgentSessionQueuePause = { reason: 'stopped' | 'failed' }

/** What rides beside a frame's `queuedMessages`, published together with the list. */
export type AgentSessionQueuePublicationFields = {
  /** Null when the queue sends on its own. */
  queuePause?: AgentSessionQueuePause | null
  /** Next automatically sent card once unblocked; null while held, and when absent on older hosts. */
  nextQueuedMessageId?: string | null
}

export type AgentSessionQueuedMessagesResumeResult = {
  /** False when nothing was paused, and on a replay of an already-run Resume. */
  resumed: boolean
}

/** An ID neighbor, resolved against the host's full queue at commit time. */
export type AgentSessionQueuedMessageMoveAnchor =
  | { beforeMessageId: string | null; afterMessageId?: never }
  | { afterMessageId: string; beforeMessageId?: never }

export type AgentSessionQueuedMessageMoveResult = {
  messageId: string
  status: 'moved' | 'unchanged' | 'gone' | 'stale'
}

/** Publish whole card lists on history/subscribe; image cards require the reader's agent-session.queued-image-cards.v1 capability. */
export type AgentSessionQueuedMessage = {
  messageId: string
  position: number
  body: AgentJournalMessageItem
  state: 'waiting' | 'returned'
  /** Accepted steer intent; not evidence of provider receipt. */
  deliveryMode?: 'queue' | 'steer'
  /** Automatic delivery is held; an explicit Send can recover this card. */
  paused?: true
  /** Conversion failure or a steer held after reopening; unknown markers remain held. */
  pausedReason?: AgentSessionQueuedMessagePausedReason
  /** Only failed submissions return cards with reason/rejection; Stop/restart withdrawals wait again. Classify returnedRejection with returnedReason as the legacy fallback, exactly as submission rejection. */
  returnedReason?: string | null
  returnedRejection?: UnreadAgentSessionFailureFact
}

/** Removal from the published list is the outcome; no reply body/text or re-ask after a lost answer. */
export type AgentSessionQueuedMessageDeleteResult =
  | { deleted: true; messageId: string }
  /** `dispatched` means it already became a submission; `missing` covers a
   *  pruned tombstone. Replays answer from tombstone receipts. */
  | { deleted: false; messageId: string; disposition: 'dispatched' | 'withdrawn' | 'missing' }

/** queuedMessageUpdate: unchanged also acknowledges a lost-reply Save retry; changed means a competing edit won without being overwritten. */
export type AgentSessionQueuedMessageUpdateResult =
  | { status: 'updated' | 'unchanged'; messageId: string; fingerprint: string }
  | { status: 'changed' | 'not-editable'; messageId: string }
  | { status: 'gone'; messageId: string; disposition: 'dispatched' | 'withdrawn' | 'missing' }

/** Edit lease keyed by authenticated caller/editId; renewal extends expiry, release frees only that editor's hold. */
export type AgentSessionQueuedMessageEditHoldParams = {
  sessionId: string
  messageId: string
  editId: string
} & ({ action: 'acquire'; expectedBodyFingerprint: string } | { action: 'renew' | 'release' })

export type AgentSessionQueuedMessageEditHoldResult =
  | { status: 'held'; fingerprint: string; leaseDurationMs: number; remainingMs: number }
  | { status: 'released' | 'expired' | 'changed' | 'gone' | 'not-editable' }
