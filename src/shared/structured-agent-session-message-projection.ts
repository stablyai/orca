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
  submissions: readonly AgentJournalSubmission[],
  projectItems = projectStructuredItemsToNativeChat
): NativeChatMessage[] {
  const optimistic = reconcileStructuredAgentSessionOutbox(outbox, submissions)
  // Refused sends are ledger evidence, not conversation history; local drafts remain in the outbox.
  const rejected = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  const visibleItems = items.filter((item) => !rejected.has(item.itemId))
  const journalled = new Set(visibleItems.map((item) => item.itemId))
  return [
    ...projectItems(visibleItems),
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
