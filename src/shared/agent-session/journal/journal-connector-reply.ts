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

// The prose a row keeps until it is sent: the turn-end cap.
export const JOURNAL_CONNECTOR_REPLY_PROSE_BYTES = 8 * 1024

export type JournalConnectorReplyKey = { account: string; deliveryId: string }

/** A row's outcome. answerDeliveryId: the earliest admitted delivery of the same turn and
 *  conversation, which keys its answer. */
export type JournalConnectorReplyFill = JournalConnectorReplyKey & {
  outcome: JournalConnectorReplyOutcome
  answerDeliveryId: string
  turnItemId?: string
  prose?: string
  failure?: ConnectorFailure
  links?: ConnectorWorkLink[]
}

/** An outbox row not yet accepted by the cloud. */
export type JournalConnectorReplyRow = JournalConnectorReplyKey & {
  conversation: { source: string; externalId: string }
  sessionId: string
  epoch: string
  /** The message that admitted it: a submission's clientMessageId, or a queue card's id. */
  messageId: string
  queued: boolean
  fill?: Omit<JournalConnectorReplyFill, keyof JournalConnectorReplyKey> & { filledAt: number }
}
