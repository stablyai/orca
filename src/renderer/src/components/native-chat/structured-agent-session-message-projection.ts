import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'

export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[]
): NativeChatMessage[] {
  const optimistic = reconcileStructuredAgentSessionOutbox(outbox, submissions)
  // Why: the host renders its own bubble off the submission WAL row, which lands
  // while the dispatch is still `pending`. Reconciliation only retires the echo on
  // `accepted`, so keying visibility on that alone double-rendered the bubble for
  // the whole provider round trip. The entry itself stays for retry/unconfirmed.
  const journalled = new Set(items.map((item) => item.itemId))
  return [
    ...projectStructuredItemsToNativeChat(items),
    ...optimistic
      .filter((entry) => !journalled.has(agentJournalSubmissionKey(entry.clientMessageId)))
      .map(
        (entry): NativeChatMessage => ({
          id: agentJournalSubmissionKey(entry.clientMessageId),
          role: 'user',
          source: 'transcript',
          timestamp: entry.queuedAt,
          blocks: entry.body.blocks
        })
      )
  ]
}
