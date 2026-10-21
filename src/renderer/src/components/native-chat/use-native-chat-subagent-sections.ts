import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../shared/native-chat-transcript-projection'
import type { StructuredAgentSubagentRoster } from '../../../../shared/structured-agent-session-subagent-roster'
import { chooseNativeChatExpanded } from './native-chat-expanded-keys'
import {
  NO_NATIVE_CHAT_SUBAGENT_CHOICES,
  nativeChatSubagentRowsInOrder,
  nativeChatSubagentSections,
  type NativeChatSubagentChoices,
  type NativeChatSubagentDisclosure,
  type NativeChatSubagentSections
} from './native-chat-subagent-sections'

function choose(
  current: NativeChatSubagentChoices,
  kind: keyof NativeChatSubagentChoices,
  key: string,
  open: boolean
): NativeChatSubagentChoices {
  const next = chooseNativeChatExpanded(current[kind], key, open)
  return next === current[kind] ? current : { ...current, [kind]: next }
}

/** The transcript's subagent sections, and the sections and roster lists the reader
 *  opened or closed by hand. Every other section is open only at its running scope's
 *  live frontier; every other roster list, while that frontier or a reader's choice is
 *  on one of its sections. */
export function useNativeChatSubagentSections(
  conversation: readonly NativeChatMessage[],
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>,
  roster?: StructuredAgentSubagentRoster
): {
  sections: NativeChatSubagentSections
  /** Every subagent row in transcript order; kept while only the conversation changes. */
  subagentRowsInOrder: readonly NativeChatSubagentRow[]
  subagentChoices: NativeChatSubagentChoices
  subagentDisclosure: NativeChatSubagentDisclosure
  /** Opens the sections a row sits in, and the roster lists they sit under, so a reveal
   *  of that row can land. */
  openSubagentSections: (agentIds: readonly string[]) => void
} {
  const sections = useMemo(
    () => nativeChatSubagentSections(conversation, subagentRows, roster),
    [conversation, roster, subagentRows]
  )
  const subagentRowsInOrder = useMemo(
    () => nativeChatSubagentRowsInOrder(subagentRows),
    [subagentRows]
  )
  const [subagentChoices, setChoices] = useState(NO_NATIVE_CHAT_SUBAGENT_CHOICES)
  const subagentDisclosure = useMemo<NativeChatSubagentDisclosure>(
    () => ({
      setSectionOpen: (agentId, open) =>
        setChoices((current) => choose(current, 'sections', agentId, open)),
      setRosterOpen: (rosterRowId, open) =>
        setChoices((current) => choose(current, 'rosters', rosterRowId, open))
    }),
    []
  )
  // Read only by a reveal, so the callback keeps one identity while the transcript streams.
  const sectionsRef = useRef(sections)
  useLayoutEffect(() => {
    sectionsRef.current = sections
  }, [sections])
  const openSubagentSections = useCallback((agentIds: readonly string[]) => {
    const opening = new Set(agentIds)
    const rosterRowIds = Array.from(sectionsRef.current.anchoredAt).flatMap(([rowId, anchored]) =>
      anchored.some((agentId) => opening.has(agentId)) ? [rowId] : []
    )
    setChoices((current) =>
      rosterRowIds.reduce(
        (choices, rowId) => choose(choices, 'rosters', rowId, true),
        agentIds.reduce((choices, agentId) => choose(choices, 'sections', agentId, true), current)
      )
    )
  }, [])
  return {
    sections,
    subagentRowsInOrder,
    subagentChoices,
    subagentDisclosure,
    openSubagentSections
  }
}
