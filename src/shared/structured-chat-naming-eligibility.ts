import type { AgentJournalSnapshot } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import { isStructuredAgentSessionCommandEntry } from './structured-agent-session-command-entry'
import { firstStructuredAgentSessionPrompt } from './structured-agent-session-first-prompt'

export function firstStructuredChatNamingPrompt(
  snapshot: AgentJournalSnapshot,
  hostStartedAt: number
): string {
  const messages = snapshot.items.filter(
    (item) =>
      item.body.kind === 'message' &&
      item.body.role === 'user' &&
      isRootAgentJournalItem(item) &&
      !isStructuredAgentSessionCommandEntry(item.body)
  )
  const first = messages[0]
  if (messages.length !== 1 || !first) {
    return ''
  }
  const submission = snapshot.submissions.find(
    (send) =>
      send.providerItemId === first.itemId ||
      agentJournalSubmissionKey(send.clientMessageId) === first.itemId
  )
  if (
    !submission ||
    submission.submittedAt < hostStartedAt ||
    submission.recovered ||
    (submission.dispatchState !== 'accepted' && submission.dispatchState !== 'pending')
  ) {
    return ''
  }
  return firstStructuredAgentSessionPrompt([first])
}
