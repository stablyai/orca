import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { createDesktopStructuredAgentSessionMessageProjection } from './structured-agent-session-message-projection'
import { noteStreamedTextProjection } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'

export function useStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly AgentJournalSubmission[]
) {
  const project = useMemo(() => createDesktopStructuredAgentSessionMessageProjection(), [])
  return useMemo(
    // Linked to the last messages when only a reply's text moved, so turn structure holds.
    () =>
      noteStreamedTextProjection(
        items,
        [optimistic, submissions],
        project(items, optimistic, submissions)
      ),
    [items, optimistic, submissions, project]
  )
}
