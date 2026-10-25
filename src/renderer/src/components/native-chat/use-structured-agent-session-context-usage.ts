import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import {
  selectStructuredAgentContextUsage,
  type StructuredAgentContextUsage
} from '../../../../shared/structured-agent-session-context-usage'

/** Fill missing loaded-window usage facts from whole-journal host evidence; older hosts leave the window unchanged. */
export function useStructuredAgentSessionContextUsage(
  journalItems: readonly AgentJournalRenderItem[],
  support: AgentSessionOptionsResult['contextUsage'],
  journalEpoch?: string | null
): StructuredAgentContextUsage | null {
  return useMemo(
    () =>
      selectStructuredAgentContextUsage(
        journalItems,
        support?.current,
        support?.contextFloor && (!journalEpoch || support.contextFloor.epoch === journalEpoch)
          ? support.contextFloor.sequence
          : 0
      ),
    [journalItems, support, journalEpoch]
  )
}
