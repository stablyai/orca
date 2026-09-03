import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type { NativeChatMessage } from './native-chat-types'
import {
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'

export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[]
): NativeChatMessage[] {
  const optimistic = reconcileStructuredAgentSessionOutbox(outbox, submissions)
  const journalled = new Set(items.map((item) => item.itemId))
  return [
    ...projectStructuredItemsToNativeChat(items),
    ...optimistic
      .filter((entry) => !journalled.has(agentJournalSubmissionKey(entry.clientMessageId)))
      .map((entry): NativeChatMessage => ({
        id: agentJournalSubmissionKey(entry.clientMessageId),
        role: 'user',
        source: 'transcript',
        timestamp: entry.queuedAt,
        blocks: entry.body.blocks
      }))
  ]
}
