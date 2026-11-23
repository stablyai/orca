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
  // Indexed once: a long turn can steer in hundreds of sends.
  const byId = new Map<string, AgentJournalRenderItem>()
  for (const item of journal.items) {
    if (!byId.has(item.itemId)) {
      byId.set(item.itemId, item)
    }
  }
  const messages = new Set(opener ? [opener] : [])
  for (const submission of journal.submissions) {
    if (
      submission.answeredInTurn?.via === 'steer' &&
      submission.answeredInTurn.turnItemId === turnItemId
    ) {
      const item = byId.get(agentJournalSubmissionKey(submission.clientMessageId))
      if (item) {
        messages.add(item)
      }
    }
  }
  return [...messages]
}
