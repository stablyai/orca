import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

export function useStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[]
) {
  const projectItems = useMemo(() => {
    // Journal revisions replace item objects; weak keys release removed history.
    const byItem = new WeakMap<AgentJournalRenderItem, NativeChatMessage | null>()
    return (rows: readonly AgentJournalRenderItem[]): NativeChatMessage[] => {
      const messages: NativeChatMessage[] = []
      for (const row of rows) {
        if (!byItem.has(row)) {
          byItem.set(row, projectStructuredItemToNativeChat(row))
        }
        const message = byItem.get(row)
        if (message) {
          messages.push(message)
        }
      }
      return messages
    }
  }, [])
  return useMemo(
    () => projectStructuredAgentSessionMessages(items, outbox, submissions, projectItems),
    [items, outbox, submissions, projectItems]
  )
}
