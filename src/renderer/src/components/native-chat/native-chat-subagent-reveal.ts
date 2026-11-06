// Reveal a subagent named from outside the transcript (the agents strip): open what holds it, then land on its newest drawn activity, else its head or entry.

import { useLayoutEffect, useRef } from 'react'
import type { StructuredAgentSubagentRoster } from '../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import {
  isSubagentGroupBlock,
  type NativeChatMessage
} from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentSections } from './native-chat-subagent-sections'
import {
  nativeChatSlotIndexOf,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'
import type { NativeChatAlignEdge } from './use-native-chat-viewport-align'

/**
 * The drawn "Kicked off" row first naming an agent. Siblings' roster items fold into the first
 * sibling's row, so an agent's own roster item id can name a row that is never drawn.
 * Scanned only on a reveal, never per frame.
 */
function rosterRowNaming(
  conversation: readonly NativeChatMessage[],
  agentId: string
): string | undefined {
  return conversation.find((message) =>
    message.blocks.some(
      (block) => isSubagentGroupBlock(block) && block.agents.some(({ id }) => id === agentId)
    )
  )?.id
}

/** Where a subagent is in the committed transcript, and what opening it takes. */
export type NativeChatSubagentPlace =
  | { kind: 'open'; agentIds: readonly string[]; rosterRowId?: string }
  | { kind: 'page' }
  | { kind: 'stop' }

export function nativeChatSubagentPlace({
  agentId,
  conversation,
  sections,
  roster,
  slots,
  historyFloor
}: {
  agentId: string
  conversation: readonly NativeChatMessage[]
  sections: NativeChatSubagentSections
  roster: StructuredAgentSubagentRoster | undefined
  slots: readonly NativeChatTranscriptSlot[]
  /** The sequence the transcript's history starts from (its latest `/clear`); 0 for none. */
  historyFloor: number
}): NativeChatSubagentPlace {
  const first = sections.rows.get(agentId)?.[0]
  if (first !== undefined) {
    // Nested sections open from the outermost, which also opens the roster anchoring it.
    return { kind: 'open', agentIds: sections.pathOf.get(first.message.id) ?? [agentId] }
  }
  // No activity yet (just spawned, or an agent that reports only its final reply): its roster entry.
  const rosterRowId = rosterRowNaming(conversation, agentId)
  if (rosterRowId !== undefined && nativeChatSlotIndexOf(slots, rosterRowId) !== -1) {
    return { kind: 'open', agentIds: [agentId], rosterRowId }
  }
  const named = roster?.get(agentId)
  if (named === undefined) {
    return { kind: 'stop' }
  }
  // A spawn before the latest /clear is outside this conversation: no page reaches it.
  return named.rosterPosition.sequence < historyFloor ? { kind: 'stop' } : { kind: 'page' }
}

export type NativeChatSubagentLanding = {
  index: number
  edge: NativeChatAlignEdge
  /** Set when the landing is the agent's entry inside a roster slot rather than a slot of its own. */
  entryId?: string
}

/** Newest drawn activity (streaming stubs draw nothing), else the section head, else the roster entry. */
export function nativeChatSubagentLanding(
  slots: readonly NativeChatTranscriptSlot[],
  conversation: readonly NativeChatMessage[],
  sections: NativeChatSubagentSections,
  agentId: string
): NativeChatSubagentLanding | null {
  const rowIds = new Set(sections.rows.get(agentId)?.map(({ message }) => message.id))
  const activity = slots.findLastIndex(
    (slot) =>
      slot.kind === 'message' &&
      (rowIds.has(slot.message.id) || slot.workRun?.some(({ id }) => rowIds.has(id)) === true)
  )
  if (activity !== -1) {
    return { index: activity, edge: 'end' }
  }
  const head = slots.findIndex((slot) => slot.kind === 'subagent' && slot.agentId === agentId)
  if (head !== -1) {
    return { index: head, edge: 'start' }
  }
  const entries = slots.findIndex(
    (slot) => slot.kind === 'subagent-entries' && slot.agents.some(({ id }) => id === agentId)
  )
  const rosterRowId = sections.rosters.get(agentId)?.rowId ?? rosterRowNaming(conversation, agentId)
  const index = entries !== -1 ? entries : nativeChatSlotIndexOf(slots, rosterRowId)
  return index >= 0 ? { index, edge: 'start', entryId: agentId } : null
}

/** Land once per request: the row's end for activity, or the entry when the row's start would leave it below the view. */
export function useNativeChatSubagentLanding({
  request,
  landing,
  scrollRef,
  scrollMessageToTop,
  release
}: {
  request: { requestId: number } | null
  landing: NativeChatSubagentLanding | null
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollMessageToTop: (element: HTMLElement, edge?: NativeChatAlignEdge) => void
  release: (request: null) => void
}): void {
  const servicedRef = useRef(0)
  useLayoutEffect(() => {
    if (request === null || servicedRef.current === request.requestId) {
      return
    }
    servicedRef.current = request.requestId
    const scroller = scrollRef.current
    const row =
      landing === null
        ? null
        : scroller?.querySelector<HTMLElement>(`[data-index="${landing.index}"]`)
    if (scroller && landing && row) {
      const entry = Array.from(
        row.querySelectorAll<HTMLElement>('[data-native-chat-subagent-entry]')
      ).find((element) => element.dataset.nativeChatSubagentEntry === landing.entryId)
      const entryBelowView =
        entry !== undefined &&
        entry.getBoundingClientRect().bottom - row.getBoundingClientRect().top >
          scroller.clientHeight
      scrollMessageToTop(entryBelowView ? entry : row, entryBelowView ? 'start' : landing.edge)
    }
    release(null)
  }, [landing, release, request, scrollMessageToTop, scrollRef])
}
