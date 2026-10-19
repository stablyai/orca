// A submission's `queuedMessageId` names the queued draft it hands off. The host sends every draft
// under a fresh submission id, so this link, never a draft id compared with a `clientMessageId`,
// is how a client knows the host has taken a message over.

import type { AgentJournalSubmission } from './agent-session-journal-types'

/** Ids of the queued drafts the journal shows handed off, in any dispatch state: the host's card or
 *  bubble carries their text from here. */
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
