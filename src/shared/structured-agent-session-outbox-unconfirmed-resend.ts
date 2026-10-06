// Which send in doubt Orca resends on its own under the same id, without the user's Retry.

import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'

/** Whether the unconfirmed probe resends this entry: in doubt, never retried by the user, not
 *  outlived by a Stop, and with no journal row yet. Any row ends it: the journal answers from there. */
export function structuredAgentSessionEntryResendsUnconfirmed(
  entry: StructuredAgentSessionOutboxEntry,
  submissions: readonly AgentJournalSubmission[]
): boolean {
  return (
    entry.state === 'unconfirmed' &&
    entry.retryAfterUnknownSubmittedAt === null &&
    entry.outlivedStop !== true &&
    !submissions.some((submission) => submission.clientMessageId === entry.clientMessageId)
  )
}
