// A submission's `queuedMessageId` names the queued draft it hands off. The host sends every draft
// under a fresh submission id, so this link, never a draft id compared with a `clientMessageId`,
// is how a client knows the host has taken a message over.

import type { AgentJournalSubmission } from './agent-session-journal-types'
import {
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'

/** Ids of the queued drafts the journal shows handed off, in any dispatch state. An outbox entry
 *  under one of these ids belongs to the host: its card or bubble carries the text from here. */
export function handedOffQueuedMessageIds(
  submissions: readonly AgentJournalSubmission[]
): Set<string> {
  const ids = new Set<string>()
  for (const submission of submissions) {
    if (submission.queuedMessageId !== undefined) {
      ids.add(submission.queuedMessageId)
    }
  }
  return ids
}

/**
 * `reconcileStructuredAgentSessionOutbox` with the queue's rule first: an entry the host handed off
 * as a queued draft belongs to the host, whatever that hand-off's state, so it leaves with no
 * restore and no Retry row. Every reading of the outbox against the journal goes through this.
 */
export function reconcileStructuredAgentSessionOutboxWithQueue(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[]
): StructuredAgentSessionOutboxEntry[] {
  const handedOff = handedOffQueuedMessageIds(submissions)
  return reconcileStructuredAgentSessionOutbox(
    handedOff.size === 0
      ? entries
      : entries.filter((entry) => !handedOff.has(entry.clientMessageId)),
    submissions
  )
}
