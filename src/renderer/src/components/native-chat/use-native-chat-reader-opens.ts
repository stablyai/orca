// Every transcript row a reader can open, routed so that opening one stops the
// transcript following its end, and abandons a history jump still paging: either
// would slide what they opened off the screen. Each is reported under its own
// identity, so closing the last row that stopped the following resumes it.

import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react'
import {
  useNativeChatDisclosures,
  type NativeChatDisclosureStore
} from './native-chat-disclosure-store'
import { toggleNativeChatExpandedKey } from './native-chat-expanded-keys'
import type { NativeChatSubagentDisclosure } from './native-chat-subagent-sections'
import type { NativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'

export function useNativeChatReaderOpens({
  subagentDisclosure,
  expandedTurnIds,
  setExpandedTurnIds,
  follow,
  abortNavigation
}: {
  subagentDisclosure: NativeChatSubagentDisclosure
  expandedTurnIds: ReadonlySet<string>
  setExpandedTurnIds: Dispatch<SetStateAction<ReadonlySet<string>>>
  follow: Pick<NativeChatTranscriptScroll, 'readerOpened' | 'readerClosed'>
  abortNavigation: () => void
}): {
  disclosures: NativeChatDisclosureStore
  subagentDisclosure: NativeChatSubagentDisclosure
  toggleExpandedTurn: (turnKey: string) => void
} {
  const disclosures = useNativeChatDisclosures()
  // Taken apart: the scroll result is a new object each render, its callbacks are not.
  const { readerOpened, readerClosed } = follow
  const readerToggled = useCallback(
    (row: string, open: boolean) => {
      if (!open) {
        readerClosed(row)
        return
      }
      abortNavigation()
      readerOpened(row)
    },
    [abortNavigation, readerClosed, readerOpened]
  )
  const readerDisclosures = useMemo(
    () => ({ ...disclosures, onToggle: readerToggled }),
    [disclosures, readerToggled]
  )
  const readerSubagentDisclosure = useMemo<NativeChatSubagentDisclosure>(
    () => ({
      setSectionOpen: (agentId, open) => {
        readerToggled(`section:${agentId}`, open)
        subagentDisclosure.setSectionOpen(agentId, open)
      },
      setRosterOpen: (rosterRowId, open) => {
        readerToggled(`roster:${rosterRowId}`, open)
        subagentDisclosure.setRosterOpen(rosterRowId, open)
      }
    }),
    [readerToggled, subagentDisclosure]
  )
  const toggleExpandedTurn = useCallback(
    (turnKey: string) => {
      readerToggled(`turn:${turnKey}`, !expandedTurnIds.has(turnKey))
      setExpandedTurnIds((current) => toggleNativeChatExpandedKey(current, turnKey))
    },
    [expandedTurnIds, readerToggled, setExpandedTurnIds]
  )
  return {
    disclosures: readerDisclosures,
    subagentDisclosure: readerSubagentDisclosure,
    toggleExpandedTurn
  }
}
