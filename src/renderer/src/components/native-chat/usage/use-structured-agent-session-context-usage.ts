import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../../../../../shared/agent-session/options/protocol/agent-session-options-result'
import {
  selectStructuredAgentSessionContextUsage,
  type StructuredAgentContextUsage
} from '../../../../../shared/agent-session/conversation-context/structured-agent-session-context-usage'
import { rowsBesideStreamedText } from '../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'

/** Older hosts send no whole-journal answer, which leaves the loaded window's facts unchanged. */
export function useStructuredAgentSessionContextUsage(
  journalItems: readonly AgentJournalRenderItem[],
  support: AgentSessionOptionsResult['contextUsage'],
  journalEpoch?: string | null
): StructuredAgentContextUsage | null {
  // Usage never reads reply text, so a streaming reply keeps the memo.
  const rows = rowsBesideStreamedText(journalItems)
  return useMemo(
    () => selectStructuredAgentSessionContextUsage(rows, support, journalEpoch),
    [rows, support, journalEpoch]
  )
}
