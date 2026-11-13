// Mark the first row that arrived or kept growing while the reader was away.

import { useCallback, useMemo, useState } from 'react'
import { useOrcaWindowForegroundFocused } from '@/hooks/use-orca-window-foreground-focused'
import { compareAgentJournalPositions } from '../../../../../../shared/agent-session/journal/agent-session-journal-position'
import type { AgentJournalPosition } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { useAppStore } from '@/store'
import { nativeChatMarksNewMessages } from '../../../../../../shared/native-chat/native-chat-appearance-settings'
import {
  nativeChatSlotIndexOf,
  nativeChatSlotKey
} from '../../conversation/slots/native-chat-transcript-slot-selection'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import {
  isMissedRow,
  isReaderPrompt,
  newestRowPosition,
  rowPosition
} from './native-chat-missed-row-positions'

/** Where a reader who looks away now has read to, and the reply the agent is still writing. */
type NativeChatLeftAt = {
  /** The newest row there was, as a position: that row may have folded away by the return. */
  position: AgentJournalPosition
  /** A growing reply counts as missed from the position immediately before it. */
  writing: { key: string; size: number; before: AgentJournalPosition } | null
  /** A turn was running, whether or not it had drawn a reply yet. */
  running: boolean
  /** The reader's prompts there were, by row key: a key stays the same from send to journal. */
  prompts: ReadonlySet<string>
  /** Those the host held in its queue, to hand to the agent later. */
  queuedPrompts: ReadonlySet<string>
}

function rowSize(slot: NativeChatTranscriptSlot): number {
  return slot.kind === 'message'
    ? JSON.stringify((slot.workRun ?? [slot.message]).map((message) => message.blocks)).length
    : 0
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
  const prompts = new Set<string>()
  const queuedPrompts = new Set<string>()
  for (const slot of all) {
    if (isReaderPrompt(slot)) {
      prompts.add(slot.message.id)
      // Held by the host, not merely drawn after a turn that is still opening.
      if (slot.message.queued) {
        queuedPrompts.add(slot.message.id)
      }
    }
  }
  // The prompt that opened a turn is in it, so a turn that has drawn no reply yet still counts.
  const running = slots.some((slot) => slot.kind === 'message' && slot.activeTurnIsWorking)
  return { position: newestRowPosition(all), writing, prompts, queuedPrompts, running }
}

/** The first row that came while the reader was away, and the journal stretch it came in. */
export type NativeChatMissedRows = {
  /** The row, not a position: a queued message is placed again when it is handed over. */
  key: string
  after: AgentJournalPosition
  /** The newest row on the return: what is written after it was watched arriving. */
  through: AgentJournalPosition
}

function nativeChatMissedRows(
  slots: readonly NativeChatTranscriptSlot[],
  { position, writing }: Pick<NativeChatLeftAt, 'position' | 'writing'>
): NativeChatMissedRows | null {
  const row = writing && slots.find((slot) => nativeChatSlotKey(slot) === writing.key)
  const after = writing && !(row && rowSize(row) === writing.size) ? writing.before : position
  const through = newestRowPosition(slots)
  const first = slots.find((slot) => isMissedRow(slot, after, through))
  return first ? { key: nativeChatSlotKey(first), after, through } : null
}

/** How the marker shows: a line only where it helps, measured by height when nothing else calls for it. */
export type NativeChatNewRowsMarkerLook =
  /** Laid out but not seen, so the marker can measure what was missed below it. */
  | 'measure'
  | 'line'
  /** Rows were missed, but too few to need a line: only the announcement tells of them. */
  | 'none'
  /** The line was seen and has faded; it keeps its space so nothing below it moves. */
  | 'faded'

/** Another agent posted, or a prompt the reader did not just send ran while they were away. */
function nativeChatMissedNeedsLine(
  slots: readonly NativeChatTranscriptSlot[],
  left: NativeChatLeftAt,
  { after, through }: NativeChatMissedRows
): boolean {
  const first = slots.find((slot) => isMissedRow(slot, after, through))
  const firstAt = first && rowPosition(first)
  return slots.some(
    (slot) =>
      // The only user rows a missed stretch admits are ones another agent sent through Orca.
      (slot.kind === 'message' &&
        slot.message.role === 'user' &&
        isMissedRow(slot, after, through)) ||
      (isReaderPrompt(slot) && nativeChatPromptRanWhileAway(slot, left, firstAt))
  )
}

/** A queued send handed over, or a prompt this pane never sent (an auto-continue, a connector delivery). */
function nativeChatPromptRanWhileAway(
  slot: Extract<NativeChatTranscriptSlot, { kind: 'message' }>,
  left: NativeChatLeftAt,
  /** Where the first missed row is. */
  firstMissedAt: AgentJournalPosition | undefined
): boolean {
  const at = rowPosition(slot)
  const key = slot.message.id
  if (
    at === undefined ||
    slot.message.queued === true ||
    compareAgentJournalPositions(at, left.position) <= 0
  ) {
    return false
  }
  if (!left.prompts.has(key)) {
    return true
  }
  // A queued send ran behind a turn that was running (with or without a reply drawn yet), or behind
  // work the reader missed. The host also holds a chat's first send while the chat opens; no turn
  // runs then, so that one runs first, its reply the answer awaited.
  return (
    left.queuedPrompts.has(key) &&
    (left.running ||
      (firstMissedAt !== undefined && compareAgentJournalPositions(at, firstMissedAt) > 0))
  )
}

export type NativeChatNewRowsMarkerPlacement = {
  /** Key of the row the marker draws in. */
  key: string
  place: 'above-row' | 'above-turn-bar'
}

export type NativeChatNewRowsMarkerState = NativeChatNewRowsMarkerPlacement & {
  look: Exclude<NativeChatNewRowsMarkerLook, 'none'>
  /** The reader has just come back: bring the marker into view, once. */
  arriving: boolean
  /** The window is in front and this pane is showing: a seen line's clock may run. */
  watching: boolean
  onArrived: () => void
  onDismiss: () => void
  /** With `look: 'measure'`: whether what came below the marker is tall enough to need a line. */
  onMeasured: (tall: boolean) => void
  /** With `look: 'line'`: the reader has seen it for long enough, so it fades out. */
  onFaded: () => void
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
  return before?.kind === 'message' &&
    before.status &&
    !before.statusAbove &&
    !before.turnDiff &&
    !before.openedPullRequests
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
  /** The marker to draw, when rows were missed and a line helps. */
  marker: NativeChatNewRowsMarkerState | undefined
  /** Rows came while the reader was away, line or not; it counts returns, so each is announced. */
  announcement: number | undefined
  /** The slot drawing the marker, or -1. */
  index: number
  /** The reader answered the conversation, so nothing in it is news to them. */
  dismiss: () => void
} {
  // Off tracks nothing, so nothing is ever marked.
  const enabled = useAppStore((state) => nativeChatMarksNewMessages(state.settings))
  const focused = useOrcaWindowForegroundFocused(enabled && isShowingLatest)
  const watching = !enabled || focused
  const [seen, setSeen] = useState<{
    watching: boolean
    /** While the reader is away: where they had read to. */
    left: NativeChatLeftAt | null
    /** Stands until the reader answers. */
    missed: NativeChatMissedRows | null
    arriving: boolean
    look: NativeChatNewRowsMarkerLook
    /** While measuring: the faded line from before, kept in place if this return needs no line. */
    faded: NativeChatMissedRows | null
    /** Returns that found rows missed. */
    returns: number
  }>({
    watching,
    left: null,
    missed: null,
    arriving: false,
    look: 'measure',
    faded: null,
    returns: 0
  })
  if (!enabled) {
    if (!seen.watching || seen.left !== null || seen.missed !== null) {
      setSeen({ ...seen, watching, left: null, missed: null, arriving: false, faded: null })
    }
  } else if (seen.watching !== watching) {
    const all = [...slots, ...waitingSlots]
    if (watching) {
      const missed = seen.left && nativeChatMissedRows(all, seen.left)
      // Weighed over the transcript only: a row still held behind the turn is marked once it joins it.
      const needsLine =
        seen.left !== null && missed !== null && nativeChatMissedNeedsLine(slots, seen.left, missed)
      // Removing a faded line for no new one would move the rows below it with nothing to show why.
      const faded =
        seen.look === 'faded' && nativeChatNewRowsMarkerPlacement(all, seen.missed) !== undefined
          ? seen.missed
          : null
      setSeen(
        seen.left && missed
          ? {
              watching,
              left: null,
              missed,
              arriving: true,
              look: needsLine ? 'line' : 'measure',
              faded: needsLine ? null : faded,
              returns: seen.returns + 1
            }
          : // Nothing new: a marker from before, faded or not drawn, stays as it was.
            { ...seen, watching, left: null, arriving: false }
      )
    } else {
      // An unanswered line whose row still stands is kept: the reader may be midway through it.
      // Once faded or never drawn, the next return is weighed afresh.
      const marked =
        (seen.look === 'line' || seen.look === 'measure') &&
        nativeChatNewRowsMarkerPlacement(all, seen.missed) !== undefined
      setSeen({ ...seen, watching, left: marked ? null : nativeChatLeftAt(slots, waitingSlots) })
    }
  }
  const { missed, look } = seen
  const placement = useMemo(() => nativeChatNewRowsMarkerPlacement(slots, missed), [slots, missed])
  const dismiss = useCallback(() => {
    // Where they left as well: an answer sent before the chat has caught up settles that too.
    setSeen((held) =>
      held.missed === null && held.left === null
        ? held
        : { ...held, missed: null, left: null, faded: null }
    )
  }, [])
  const onArrived = useCallback(() => {
    setSeen((held) => (held.arriving ? { ...held, arriving: false } : held))
  }, [])
  const onMeasured = useCallback((tall: boolean) => {
    setSeen((held) =>
      held.look !== 'measure'
        ? held
        : tall
          ? { ...held, look: 'line', faded: null }
          : held.faded
            ? { ...held, missed: held.faded, look: 'faded', arriving: false, faded: null }
            : { ...held, look: 'none', arriving: false }
    )
  }, [])
  const onFaded = useCallback(() => {
    setSeen((held) => (held.look === 'line' ? { ...held, look: 'faded' } : held))
  }, [])
  const { key, place } = placement ?? {}
  const marker = useMemo(
    () =>
      key && place && look !== 'none'
        ? {
            key,
            place,
            look,
            arriving: seen.arriving,
            watching: focused,
            onArrived,
            onDismiss: dismiss,
            onMeasured,
            onFaded
          }
        : undefined,
    [key, place, look, seen.arriving, focused, onArrived, dismiss, onMeasured, onFaded]
  )
  return {
    marker,
    announcement: key ? seen.returns : undefined,
    index: marker ? nativeChatSlotIndexOf(slots, key) : -1,
    dismiss
  }
}
