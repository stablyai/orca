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
  const messages = opener ? [opener] : []
  for (const submission of journal.submissions) {
    if (
      submission.answeredInTurn?.via === 'steer' &&
      submission.answeredInTurn.turnItemId === turnItemId
    ) {
      const key = agentJournalSubmissionKey(submission.clientMessageId)
      const item = journal.items.find((candidate) => candidate.itemId === key)
      if (item && !messages.includes(item)) {
        messages.push(item)
      }
    }
  }
  return messages
}
