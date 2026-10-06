// What the structured chat's delivery-notice tests build on: an outbox entry, and the words each
// message's notice says.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  structuredAgentSessionDeliveryNotices,
  type StatedStartFailure
} from './structured-agent-session-delivery-notices'

export function entry(
  clientMessageId: string,
  patch: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId,
      sessionId: 'session-1',
      text: clientMessageId,
      attachments: [],
      queuedAt: 1
    }),
    ...patch
  }
}

export const NOT_FAILED_HERE: ReadonlySet<string> = new Set()
// What the row shows, quietly in place of its time, while nothing has confirmed the message.
export const SENDING = 'Sending…'

export function texts(
  outbox: StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[] = [],
  startFailures: readonly StatedStartFailure[] = [],
  /** Whether the host queues a message no agent took again under its own id. */
  retriesInPlace = false
): Record<string, string> {
  // Every failure seen while the chat was open, so each words its whole cause.
  const notices = structuredAgentSessionDeliveryNotices(
    outbox,
    'Claude',
    () => {},
    submissions,
    startFailures,
    new Set(outbox.map((candidate) => candidate.clientMessageId)),
    [],
    undefined,
    [],
    retriesInPlace
  )
  return Object.fromEntries(
    [...notices].map(([id, notice]) => [id, notice.sending ? SENDING : notice.text])
  )
}
