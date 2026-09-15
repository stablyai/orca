import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { liveStructuredAgentSessionItems } from '../../../../shared/structured-agent-session-projection'

export { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'

export type StructuredPromptItem = AgentJournalRenderItem & {
  body: Extract<AgentJournalRenderItem['body'], { kind: 'approval' | 'question' }>
}

export function pendingStructuredSessionPrompts(
  items: AgentJournalRenderItem[],
  currentFence?: number | null
): StructuredPromptItem[] {
  return liveStructuredAgentSessionItems(items, currentFence).filter(
    (item): item is StructuredPromptItem =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending'
  )
}
