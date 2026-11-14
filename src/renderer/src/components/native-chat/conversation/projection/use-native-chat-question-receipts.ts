import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { desktopStructuredTranscript } from './structured-agent-session-message-projection'

/** Answered questions' receipts by message, from one incremental transcript stream per list. */
export function useNativeChatQuestionReceipts(
  journalItems: readonly AgentJournalRenderItem[] | undefined
) {
  const questionTranscript = useMemo(() => desktopStructuredTranscript.stream(), [])
  return useMemo(
    () => (journalItems ? questionTranscript(journalItems).receipts : new Map()),
    [journalItems, questionTranscript]
  )
}
