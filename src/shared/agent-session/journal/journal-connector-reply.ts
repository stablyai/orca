import type { ConnectorFailure } from '../../connectors/connector-cloud-contract'
import type { ConnectorWorkLink } from '../../connector-work-link-contract'

/** How an admitted connector request ended, as the machine that ran it says (design item 125). */
export const JOURNAL_CONNECTOR_REPLY_OUTCOMES = [
  'answered',
  'quiet',
  'no_answer',
  'interrupted',
  'failed',
  'cancelled',
  'withdrawn',
  'cleared',
  'not_found',
  'unattributed'
] as const
export type JournalConnectorReplyOutcome = (typeof JOURNAL_CONNECTOR_REPLY_OUTCOMES)[number]

// The prose a row keeps until it is sent: the most any cloud takes (its long-answer cap); one sent
// to a cloud that takes less is cut to that as it goes.
export const JOURNAL_CONNECTOR_REPLY_PROSE_BYTES = 32 * 1024

export type JournalConnectorReplyKey = { account: string; deliveryId: string }

/** Only Slack's conversations are answered through the outbox; the others keep their turn's end. */
export const answersThroughOutbox = (source: string): boolean => source === 'slack'

/** Who may still settle a row (Phase 1): a cut a continuation is owed, and the committed
 *  continuation message that claimed it. A restart cut names a turn or a send; a usage-limit cut
 *  names its turn. */
export type JournalConnectorReplyCut = { turnId: string; kind: 'restart' | 'usage_limit' }

/** The state a fill expects its row in, else it changes nothing: open (no cut, no claim) when
 *  absent; claimed by that message; or owed by that cut and unclaimed. */
export type JournalConnectorReplyExpect = { claimMessageId: string } | { cutTurnId: string }

/** A row's outcome. answerDeliveryId: the earliest admitted delivery of the same turn and
 *  conversation, which keys its answer. */
export type JournalConnectorReplyFill = JournalConnectorReplyKey & {
  expect?: JournalConnectorReplyExpect
  outcome: JournalConnectorReplyOutcome
  answerDeliveryId: string
  turnItemId?: string
  prose?: string
  failure?: ConnectorFailure
  links?: ConnectorWorkLink[]
  /** How long the answered turn ran, on the machine's own clock. */
  tookMs?: number
  /** The answering turn's turn-started `at`, as its conversation was told; absent when unknown. */
  turnStartedAt?: number
  /** A turn done without an answer ran a tool call that may have acted, so its line asks to check. */
  toolsRan?: true
}

/** An outbox row not yet accepted by the cloud. */
export type JournalConnectorReplyRow = JournalConnectorReplyKey & {
  conversation: { source: string; externalId: string }
  sessionId: string
  epoch: string
  /** The message that admitted it: a submission's clientMessageId, or a queue card's id. */
  messageId: string
  queued: boolean
  cut?: JournalConnectorReplyCut
  claimMessageId?: string
  /** Unfilled: the usage-limit failure its cut keeps for a close without a continuation. */
  cutFailure?: ConnectorFailure
  /** Its turn ended with no answer and was asked once more; never asked again. */
  emptyRetried?: true
  fill?: Omit<JournalConnectorReplyFill, keyof JournalConnectorReplyKey> & { filledAt: number }
  /** The quiet-marker rule in effect when it was admitted: 'trailing' drops only the trailing
   *  marker. Absent (admitted by an older build): the marker silences the whole reply, except an
   *  owner's own DM. */
  quietRule?: 'trailing'
}

/** An empty turn's rows held for its one retry: its open rows and the rows its continuation
 *  claimed, cut for the retry to claim, and marked retried. */
export type JournalConnectorReplyRetryRows = {
  keys: readonly JournalConnectorReplyKey[]
  claims: readonly string[]
  cut: JournalConnectorReplyCut
}

/** Open rows a cut now owes; a failure (a usage-limit cut's, with its reset) is kept for its close. */
export type JournalConnectorReplyCutRows = {
  keys: readonly JournalConnectorReplyKey[]
  cut: JournalConnectorReplyCut
  failure?: ConnectorFailure
}
