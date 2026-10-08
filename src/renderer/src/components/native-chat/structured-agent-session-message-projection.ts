import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../shared/structured-agent-session-message-projection'
import { projectStructuredAgentSessionMessages as projectMessages } from '../../../../shared/structured-agent-session-message-projection'
import { projectStructuredQuestionMessages } from './structured-agent-question-projection'

/** The desktop's transcript: a message the host accepted and then rejected stays where it was
 *  sent, as not sent, unless the queue holds it as a card. */
export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly AgentJournalSubmission[]
) {
  return projectMessages(
    items,
    optimistic,
    submissions,
    { rejectedInPlace: true },
    projectStructuredQuestionMessages
  )
}

export type StructuredPromptItem = AgentJournalRenderItem & {
  body: Extract<AgentJournalRenderItem['body'], { kind: 'approval' | 'question' }>
}

export function pendingStructuredSessionPrompts(
  items: AgentJournalRenderItem[]
): StructuredPromptItem[] {
  return items.filter(
    (item): item is StructuredPromptItem =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending'
  )
}
