import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/agent-session-options-result'
import {
  selectStructuredAgentSessionContextUsage,
  type StructuredAgentContextUsage
} from '../../../../shared/agent-session/structured-agent-session-context-usage'

/** Older hosts send no whole-journal answer, which leaves the loaded window's facts unchanged. */
export function useStructuredAgentSessionContextUsage(
  journalItems: readonly AgentJournalRenderItem[],
  support: AgentSessionOptionsResult['contextUsage'],
  journalEpoch?: string | null
): StructuredAgentContextUsage | null {
  return useMemo(
    () => selectStructuredAgentSessionContextUsage(journalItems, support, journalEpoch),
    [journalItems, support, journalEpoch]
  )
}
