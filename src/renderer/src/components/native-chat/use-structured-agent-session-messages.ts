import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../shared/structured-agent-session-message-projection'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

export function useStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly AgentJournalSubmission[]
) {
  return useMemo(
    () => projectStructuredAgentSessionMessages(items, optimistic, submissions),
    [items, optimistic, submissions]
  )
}
