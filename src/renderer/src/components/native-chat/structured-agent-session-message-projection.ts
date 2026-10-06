import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { projectStructuredAgentSessionMessages as projectMessages } from '../../../../shared/structured-agent-session-message-projection'
import { projectStructuredQuestionMessages } from './structured-agent-question-projection'

/** The desktop's transcript: a message the host accepted and then rejected stays where it was
 *  sent, as not sent, unless a queued card holds it. */
export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  /** The queue's live cards; required, since a rejected message a card holds must not draw twice. */
  queuedMessageIds: readonly string[]
) {
  return projectMessages(
    items,
    outbox,
    submissions,
    { rejectedInPlace: true, queuedMessageIds },
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
