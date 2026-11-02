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

/**
 * Where the host's published state holds a client's sends, by the id each was sent under: as a
 * card (on the queue, or handed off from it), or recorded as a submission. Either settles the send,
 * whichever of that and the send's own answer comes first; a card wins.
 */
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
