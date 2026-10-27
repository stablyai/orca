// Mark the first row that arrived or kept growing while the reader was away.

import { useCallback, useMemo, useState } from 'react'
import { useOrcaWindowForegroundFocused } from '@/hooks/use-orca-window-foreground-focused'
import { compareAgentJournalPositions } from '../../../../shared/agent-session-journal-position'
import type { AgentJournalPosition } from '../../../../shared/agent-session-journal-types'
import { nativeChatSlotKey, type NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** Use journal positions for conversation rows, including folded-turn bars; terminal-backed rows have none and remain unmarked. */
function rowPosition(slot: NativeChatTranscriptSlot): AgentJournalPosition | undefined {
  return slot.kind === 'message' && slot.depth === 0 && (slot.drawsMessage || slot.statusAbove)
    ? slot.message.journalPosition
    : undefined
}

/** Before every row the journal places: what the reader has read to when no row precedes. */
const BEFORE_EVERY_ROW: AgentJournalPosition = { sequence: -1, index: 0 }

/** Where a reader who looks away now has read to, and the reply the agent is still writing. */
type NativeChatLeftAt = {
  /** The newest row there was, as a position: that row may have folded away by the return. */
  position: AgentJournalPosition
  /** A growing reply counts as missed from the position immediately before it. */
  writing: { key: string; size: number; before: AgentJournalPosition } | null
}

function rowSize(slot: NativeChatTranscriptSlot): number {
  return slot.kind === 'message'
    ? JSON.stringify((slot.workRun ?? [slot.message]).map((message) => message.blocks)).length
    : 0
}

function newestRowPosition(
  slots: readonly NativeChatTranscriptSlot[],
  limit?: AgentJournalPosition
): AgentJournalPosition {
  let newest = BEFORE_EVERY_ROW
  for (const slot of slots) {
    const at = rowPosition(slot)
    if (
      at &&
      (!limit || compareAgentJournalPositions(at, limit) < 0) &&
      compareAgentJournalPositions(at, newest) > 0
    ) {
      newest = at
    }
  }
  return newest
}

function nativeChatLeftAt(
  slots: readonly NativeChatTranscriptSlot[],
  waitingSlots: readonly NativeChatTranscriptSlot[]
): NativeChatLeftAt {
  const all = [...slots, ...waitingSlots]
  // Later user prompts or held sends do not stop the turn’s latest assistant row from growing.
  const writer = slots.findLast(
    (slot) =>
      slot.kind === 'message' &&
      slot.activeTurnIsWorking &&
      slot.message.role !== 'user' &&
      rowPosition(slot) !== undefined
  )
  const at = writer && rowPosition(writer)
  const writing = at
    ? { key: nativeChatSlotKey(writer), size: rowSize(writer), before: newestRowPosition(all, at) }
    : null
  return { position: newestRowPosition(all), writing }
}

/** The first row that came while the reader was away, and the journal stretch it came in. */
export type NativeChatMissedRows = {
  /** The row, not a position: a queued message is placed again when it is handed over. */
  key: string
  after: AgentJournalPosition
  /** The newest row on the return: what is written after it was watched arriving. */
  through: AgentJournalPosition
}

function isMissedRow(
  slot: NativeChatTranscriptSlot,
  after: AgentJournalPosition,
  through: AgentJournalPosition
): boolean {
  const at = rowPosition(slot)
  return (
    at !== undefined &&
    compareAgentJournalPositions(at, after) > 0 &&
    compareAgentJournalPositions(at, through) <= 0 &&
    (slot.kind !== 'message' || slot.message.role !== 'user' || slot.message.from !== undefined)
  )
}

function nativeChatMissedRows(
  slots: readonly NativeChatTranscriptSlot[],
  { position, writing }: NativeChatLeftAt
): NativeChatMissedRows | null {
  const row = writing && slots.find((slot) => nativeChatSlotKey(slot) === writing.key)
  const after = writing && !(row && rowSize(row) === writing.size) ? writing.before : position
  const through = newestRowPosition(slots)
  const first = slots.find((slot) => isMissedRow(slot, after, through))
  return first ? { key: nativeChatSlotKey(first), after, through } : null
}

export type NativeChatNewRowsMarkerPlacement = {
  /** Key of the row the marker draws in. */
  key: string
  place: 'above-row' | 'above-turn-bar'
}

export type NativeChatNewRowsMarkerState = NativeChatNewRowsMarkerPlacement & {
  /** The reader has just come back: bring the marker into view, once. */
  arriving: boolean
  onArrived: () => void
  onDismiss: () => void
}

/** Place above the first missed row, or its turn bar when the two lines would otherwise touch. */
export function nativeChatNewRowsMarkerPlacement(
  slots: readonly NativeChatTranscriptSlot[],
  missed: NativeChatMissedRows | null
): NativeChatNewRowsMarkerPlacement | undefined {
  if (missed === null) {
    return undefined
  }
  const { key, after, through } = missed
  // Opening a folded turn draws missed rows above the one marked while it was shut.
  const index = slots.findIndex(
    (slot) => nativeChatSlotKey(slot) === key || isMissedRow(slot, after, through)
  )
  const first = slots[index]
  if (!first) {
    return undefined
  }
  const before = slots[index - 1]
  return before?.kind === 'message' && before.status && !before.statusAbove && !before.turnDiff
    ? { key: nativeChatSlotKey(before), place: 'above-turn-bar' }
    : { key: nativeChatSlotKey(first), place: 'above-row' }
}

export function useNativeChatNewRowsMarker(
  slots: readonly NativeChatTranscriptSlot[],
  /** Rows held behind the running turn: seen and missed like any other, drawn outside `slots`. */
  waitingSlots: readonly NativeChatTranscriptSlot[],
  /** The pane is the one showing, and shows what the host holds now. */
  isShowingLatest: boolean
): {
  marker: NativeChatNewRowsMarkerState | undefined
  /** The reader answered the conversation, so nothing in it is news to them. */
  dismiss: () => void
} {
  const watching = useOrcaWindowForegroundFocused(isShowingLatest)
  const [seen, setSeen] = useState<{
    watching: boolean
    /** While the reader is away: where they had read to. */
    left: NativeChatLeftAt | null
    /** Stands until the reader answers. */
    missed: NativeChatMissedRows | null
    arriving: boolean
  }>({ watching, left: null, missed: null, arriving: false })
  if (seen.watching !== watching) {
    const all = [...slots, ...waitingSlots]
    if (watching) {
      const missed = seen.left ? nativeChatMissedRows(all, seen.left) : seen.missed
      setSeen({ watching, left: null, missed, arriving: seen.left !== null && missed !== null })
    } else {
      // An unanswered marker whose row still stands is kept: the reader may be midway through it.
      const marked = nativeChatNewRowsMarkerPlacement(all, seen.missed) !== undefined
      setSeen({ ...seen, watching, left: marked ? null : nativeChatLeftAt(slots, waitingSlots) })
    }
  }
  const { missed } = seen
  const placement = useMemo(() => nativeChatNewRowsMarkerPlacement(slots, missed), [slots, missed])
  const dismiss = useCallback(() => {
    // Where they left as well: an answer sent before the chat has caught up settles that too.
    setSeen((held) =>
      held.missed === null && held.left === null ? held : { ...held, missed: null, left: null }
    )
  }, [])
  const onArrived = useCallback(() => {
    setSeen((held) => (held.arriving ? { ...held, arriving: false } : held))
  }, [])
  const { key, place } = placement ?? {}
  const marker = useMemo(
    () =>
      key && place
        ? { key, place, arriving: seen.arriving, onArrived, onDismiss: dismiss }
        : undefined,
    [key, place, seen.arriving, onArrived, dismiss]
  )
  return { marker, dismiss }
}
