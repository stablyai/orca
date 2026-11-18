import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  type StructuredAgentSessionOptimisticMessage,
  projectStructuredAgentSessionMessages as projectMessages
} from '../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { createStructuredAgentSessionMessageProjection } from '../../../../../../shared/agent-session/view/structured-agent-session-message-stream'
import { createStructuredQuestionProjection } from '../../../../../../shared/native-chat/transcript/messages/structured-agent-question-projection'
import { projectStructuredOrcaCardItem } from '../../../../../../shared/structured-automation-saved-projection'

export const desktopStructuredTranscript = createStructuredQuestionProjection(
  projectStructuredOrcaCardItem
)

/** Keep host-recorded rejections in place as not sent unless a queue card owns them. */
export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly AgentJournalSubmission[]
) {
  return projectMessages(items, optimistic, submissions, desktopStructuredTranscript.messages)
}

/** One mounted chat's messages across journal commits. */
export function createDesktopStructuredAgentSessionMessageProjection() {
  return createStructuredAgentSessionMessageProjection(desktopStructuredTranscript.messages)
}
