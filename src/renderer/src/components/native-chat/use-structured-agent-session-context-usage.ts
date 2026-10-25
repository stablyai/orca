import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import {
  selectStructuredAgentContextUsage,
  type StructuredAgentContextUsage
} from '../../../../shared/structured-agent-session-context-usage'

/** The ring's usage: the loaded window's facts, with the host's whole-journal answer
 *  filling a part the window lacks. A host without that answer leaves the window's alone. */
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
