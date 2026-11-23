import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { rowsBesideStreamedText } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { desktopStructuredTranscript } from './structured-agent-session-message-projection'

/** Answered questions' receipts by message, from one incremental transcript stream per list. */
export function useNativeChatQuestionReceipts(
  journalItems: readonly AgentJournalRenderItem[] | undefined
) {
  const questionTranscript = useMemo(() => desktopStructuredTranscript.stream(), [])
  // Receipts read questions and answers, never reply text, so a streaming reply leaves them be.
  const savedItems = journalItems && rowsBesideStreamedText(journalItems)
  return useMemo(
    () => (savedItems ? questionTranscript(savedItems).receipts : new Map()),
    [savedItems, questionTranscript]
  )
}
