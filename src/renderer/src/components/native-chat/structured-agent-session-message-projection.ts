import { selectAgentSessionCurrentRequests } from '../../../../shared/agent-session-current-requests'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../shared/structured-agent-session-message-projection'
import { projectStructuredAgentSessionMessages as projectMessages } from '../../../../shared/structured-agent-session-message-projection'
import { projectStructuredQuestionMessages } from '../../../../shared/structured-agent-question-projection'
import { isActionableStructuredAgentSessionPrompt } from '../../../../shared/structured-agent-session-live-turn'

/** The desktop's transcript: a message the host accepted and then rejected stays where it was
 *  sent, as not sent, unless the queue holds it as a card. */
export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly AgentJournalSubmission[]
) {
  return projectMessages(items, optimistic, submissions, projectStructuredQuestionMessages)
}

export type StructuredPromptItem = AgentJournalRenderItem & {
  body: Extract<AgentJournalRenderItem['body'], { kind: 'approval' | 'question' }>
}

/** The prompt cards a person can answer: pending, and named by the host as waiting
 *  (`isActionableStructuredAgentSessionPrompt`) when the host names them. */
export function pendingStructuredSessionPrompts({
  journalItems,
  currentRequests,
  actionablePromptIds
}: {
  journalItems: AgentJournalRenderItem[]
  currentRequests?: AgentJournalRenderItem[]
  actionablePromptIds?: readonly string[]
}): StructuredPromptItem[] {
  return selectAgentSessionCurrentRequests({ items: journalItems, currentRequests }).filter(
    (item): item is StructuredPromptItem =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending' &&
      isActionableStructuredAgentSessionPrompt(item.itemId, actionablePromptIds)
  )
}
