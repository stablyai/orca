// How the journal's view of each submission settles the outbox: the sibling of
// `disposeStructuredAgentSessionSendResult`, which folds a single send's answer.

import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import {
  structuredAgentSessionEntryRejectedByHost,
  structuredAgentSessionRejectedFailure,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'

export function reconcileStructuredAgentSessionOutbox(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  /** The loaded journal rows: a rejected message leaves only once the row that draws it is here. */
  items: readonly AgentJournalRenderItem[]
): readonly StructuredAgentSessionOutboxEntry[] {
  const settled = new Map(submissions.map((entry) => [entry.clientMessageId, entry]))
  let loaded: Set<string> | undefined
  // An entry whose reconciled value is unchanged is returned as itself, and so is the list when
  // none changed: a caller re-reading every journal batch writes nothing then.
  const next = entries.flatMap((entry) => {
    const submission = settled.get(entry.clientMessageId)
    // Settled by the host: its history shows one delivered; a withdrawn one goes back to the
    // composer.
    if (submission?.dispatchState === 'accepted' || dispatchWasWithdrawn(submission)) {
      return []
    }
    // The host kept it as a card, which carries the text from here, edited or deleted included.
    if (
      submission?.dispatchState === 'rejected' &&
      submission.keptAsQueuedMessageId !== undefined
    ) {
      return []
    }
    if (submission?.dispatchState === 'rejected') {
      // Its row draws it once loaded; until then the entry does, as the host recorded it. An older
      // host leaves that row where it was sent, which may be outside the loaded window.
      loaded ??= new Set(items.map((item) => item.itemId))
      if (loaded.has(agentJournalSubmissionKey(entry.clientMessageId))) {
        return []
      }
      const lastFailure = structuredAgentSessionRejectedFailure(submission)
      return [
        structuredAgentSessionEntryRejectedByHost(entry)
          ? entry
          : { ...entry, state: 'rejected' as const, lastFailure }
      ]
    }
    if (submission?.dispatchState === 'pending') {
      if (entry.state === 'dispatching') {
        return [entry]
      }
      // The host has it, so no failure of an earlier attempt describes it now.
      const { lastFailure: _landed, ...landed } = entry
      return [{ ...landed, state: 'dispatching' as const }]
    }
    if (
      submission?.dispatchState === 'unknown' &&
      entry.retryAfterUnknownSubmittedAt !== -1 &&
      entry.retryAfterUnknownSubmittedAt !== submission.submittedAt
    ) {
      // In doubt now, not failed: the probe's resend decides it, as for any unconfirmed send.
      if (entry.state === 'unconfirmed' && entry.lastFailure === undefined) {
        return [entry]
      }
      const { lastFailure: _superseded, ...inDoubt } = entry
      return [{ ...inDoubt, state: 'unconfirmed' as const }]
    }
    return [entry]
  })
  return next.length === entries.length && next.every((entry, index) => entry === entries[index])
    ? entries
    : next
}
