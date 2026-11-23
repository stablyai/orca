import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'

/** The messages a turn answered, by the provider's own record: its opener, then each send the
 *  provider accepted into the turn as a steer (`answeredInTurn`). A message's turn scope alone is
 *  not evidence: the host assigns it at handover, before the provider takes the input.
 *  `turnItemId`: the turn row's journal item key. */
export function journalTurnAnsweredMessages(
  journal: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  },
  opener: AgentJournalRenderItem | null | undefined,
  turnItemId: string
): AgentJournalRenderItem[] {
  const keys = journal.submissions.flatMap((submission) =>
    submission.answeredInTurn?.via === 'steer' &&
    submission.answeredInTurn.turnItemId === turnItemId
      ? [agentJournalSubmissionKey(submission.clientMessageId)]
      : []
  )
  // One pass over the rows, stopping once every steered send is found: a long turn steers hundreds.
  const found = new Map<string, AgentJournalRenderItem | null>(keys.map((key) => [key, null]))
  let missing = found.size
  for (const item of journal.items) {
    if (missing === 0) {
      break
    }
    if (found.get(item.itemId) === null) {
      found.set(item.itemId, item)
      missing -= 1
    }
  }
  const messages = new Set(opener ? [opener] : [])
  for (const key of keys) {
    const item = found.get(key)
    if (item) {
      messages.add(item)
    }
  }
  return [...messages]
}
