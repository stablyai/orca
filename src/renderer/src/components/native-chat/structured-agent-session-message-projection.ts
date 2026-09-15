import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

export { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'

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
