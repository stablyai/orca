import type { AgentJournalCursor } from '../journal/agent-session-journal-identity'
import type { AgentJournalSubmissionFields } from '../journal/agent-session-journal-types'
import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING } from './structured-agent-session-send-evidence'
import { handedOffQueuedMessageIds } from '../view/structured-agent-session-draft-hand-off'

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

type SettledSends = {
  cards: ReadonlySet<string>
  recorded: ReadonlyMap<string, AgentJournalSubmissionFields>
}

const settlementBySubmissions = new WeakMap<
  readonly AgentJournalSubmissionFields[],
  {
    recorded: SettledSends['recorded']
    handoffs: ReadonlySet<string>
    byQueue: WeakMap<readonly string[], SettledSends>
  }
>()

/** Settle by host-published ID as queued card/handoff or submission, whichever arrives before the send response; cards win. */
export function structuredAgentSessionSettledSends(
  submissions: readonly AgentJournalSubmissionFields[],
  queuedMessageIds: readonly string[]
): SettledSends {
  let facts = settlementBySubmissions.get(submissions)
  if (!facts) {
    const rows = submissions.filter(
      (row) => row.reason !== STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING
    )
    facts = {
      recorded: new Map(rows.map((submission) => [submission.clientMessageId, submission])),
      handoffs: handedOffQueuedMessageIds(rows),
      byQueue: new WeakMap()
    }
    settlementBySubmissions.set(submissions, facts)
  }
  let settled = facts.byQueue.get(queuedMessageIds)
  if (!settled) {
    settled = {
      cards: new Set([...queuedMessageIds, ...facts.handoffs]),
      recorded: facts.recorded
    }
    facts.byQueue.set(queuedMessageIds, settled)
  }
  return settled
}
