import { useMemo } from 'react'
import { rowsBesideStreamedText } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { isStructuredAgentSessionThinking } from '../../../../../../shared/agent-session/view/structured-agent-session-live-turn'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionLatestTurn } from '../../../../../../shared/agent-session/agent-session-wire'

/** Only real tail reasoning counts as thinking; an in-flight request with no output does not. Reads roles and
 *  lifecycles, never reply text, so it holds while a reply streams. A subagent's view never thinks. */
export function useNativeChatTranscriptThinking(
  journalItems: readonly AgentJournalRenderItem[] | undefined,
  latestTurn: AgentSessionLatestTurn | null | undefined,
  isSubagentView: boolean
): boolean {
  const structureItems = journalItems && rowsBesideStreamedText(journalItems)
  return useMemo(
    () =>
      !isSubagentView &&
      isStructuredAgentSessionThinking({ items: structureItems ?? [], latestTurn }),
    [structureItems, latestTurn, isSubagentView]
  )
}
