import type { AgentJournalCursor, AgentJournalSubmission } from './agent-session-journal-types'
import { handedOffQueuedMessageIds } from './structured-agent-session-draft-hand-off'

/** A bounded read supersedes acknowledged sends even when their rows are outside its page. */
export function structuredAgentSessionReadCoversSend(
  cursor: AgentJournalCursor | null | undefined,
  acknowledged: AgentJournalCursor | null | undefined
): boolean {
  return Boolean(
    cursor &&
    acknowledged &&
    cursor.epoch === acknowledged.epoch &&
    cursor.sequence >= acknowledged.sequence
  )
}

/** Settle by host-published ID as queued card/handoff or submission, whichever arrives before the send response; cards win. */
export function structuredAgentSessionSettledSends(
  submissions: readonly AgentJournalSubmission[],
  queuedMessageIds: readonly string[]
): {
  cards: ReadonlySet<string>
  recorded: ReadonlyMap<string, AgentJournalSubmission>
} {
  return {
    cards: new Set([...queuedMessageIds, ...handedOffQueuedMessageIds(submissions)]),
    recorded: new Map(submissions.map((submission) => [submission.clientMessageId, submission]))
  }
}
