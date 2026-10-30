import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../shared/structured-agent-session-message-projection'
import { projectStructuredAgentSessionMessages as projectMessages } from '../../../../shared/structured-agent-session-message-projection'
import { createStructuredQuestionProjection } from '../../../../shared/structured-agent-question-projection'
import { projectStructuredAgentStartItem } from '../../../../shared/structured-agent-start-projection'

export const desktopStructuredTranscript = createStructuredQuestionProjection(
  projectStructuredAgentStartItem
)

/** Keep host-recorded rejections in place as not sent unless a queue card owns them. */
export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly AgentJournalSubmission[]
) {
  return projectMessages(items, optimistic, submissions, desktopStructuredTranscript.messages)
}
