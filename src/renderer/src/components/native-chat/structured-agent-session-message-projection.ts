import { selectAgentSessionCurrentRequests } from '../../../../shared/agent-session-current-requests'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../shared/structured-agent-session-message-projection'
import { projectStructuredAgentSessionMessages as projectMessages } from '../../../../shared/structured-agent-session-message-projection'
import { projectStructuredQuestionMessages } from '../../../../shared/structured-agent-question-projection'
import { isActionableStructuredAgentSessionPrompt } from '../../../../shared/structured-agent-session-live-turn'

/** Keep host-recorded rejections in place as not sent unless a queue card owns them. */
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

/** Offer pending prompts, respecting the host’s actionable-wait declaration when available. */
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
