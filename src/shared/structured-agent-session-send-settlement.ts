import type { AgentJournalCursor, AgentJournalSubmission } from './agent-session-journal-types'
import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING } from './structured-agent-session-send-evidence'
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
  const rows = submissions.filter(
    (row) => row.reason !== STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING
  )
  return {
    cards: new Set([...queuedMessageIds, ...handedOffQueuedMessageIds(rows)]),
    recorded: new Map(rows.map((submission) => [submission.clientMessageId, submission]))
  }
}
