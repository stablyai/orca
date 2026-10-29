// Fresh submission IDs differ from draft IDs; queuedMessageId alone proves the host took over a queued draft.

import type { AgentJournalSubmission } from './agent-session-journal-types'

/** Include handoffs in every dispatch state; the host card/bubble now owns their text. */
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
