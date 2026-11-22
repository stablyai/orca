import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** The row gap in `--spacing` units (`gap-5`, and the virtualizer's scaled 20 px). */
const ROW_GAP_UNITS = 5
/** `-mb-3`: a row the agent's next step follows directly sits close to it. */
const TUCK_UNITS = 3
/** `-mt-4`: a row opening on an activity row is drawn 4 px below the one above. */
const ACTIVITY_JOIN_UNITS = 4
const OUTSET_UNITS = 2

/** Whether the row pulls the next one up with `-mb-3`. A row the "New" line follows keeps the full gap. */
export function nativeChatSlotTucksNextRow(
  slot: NativeChatTranscriptSlot,
  newRowsMarkerBelow: boolean
): boolean {
  return (
    slot.kind === 'message' &&
    slot.continuesTurn === true &&
    !(slot.endsResponse && !slot.activeTurnIsWorking) &&
    !newRowsMarkerBelow
  )
}

/** The gap a row's own margins leave between it and the row below. Negative when both margins
 *  apply and the rows overlap: the card then follows that overlap rather than painting it twice. */
function nativeChatRowGapUnits(tucksNext: boolean, nextJoinsActivityAbove: boolean): number {
  return (
    ROW_GAP_UNITS -
    (tucksNext ? TUCK_UNITS : 0) -
    (nextJoinsActivityAbove ? ACTIVITY_JOIN_UNITS : 0)
  )
}

function isAnswerRow(
  slot: NativeChatTranscriptSlot | undefined
): slot is NativeChatTranscriptSlot & { kind: 'message' } {
  return (
    slot?.kind === 'message' &&
    slot.turnKey !== undefined &&
    slot.message.role !== 'user' &&
    !slot.itemNotes
  )
}

export type NativeChatAnswerCardEdges = {
  joinsAbove: boolean
  joinsBelow: boolean
  /** `--spacing` units the card reaches past the row's top and bottom (negative: stops short of
   *  it): none above a joined edge, the whole gap below one, and otherwise an outset that stays
   *  clear of the neighbouring row. */
  aboveUnits: number
  belowUnits: number
}

/** One glass card spans an agent answer's rows; each row paints its part, meeting its neighbours
 *  across the exact gap the transcript leaves between them, so the layout itself never changes. */
function nativeChatAnswerCardEdges({
  slot,
  previous,
  next,
  gapAboveUnits,
  gapBelowUnits
}: {
  slot: NativeChatTranscriptSlot
  previous: NativeChatTranscriptSlot | undefined
  next: NativeChatTranscriptSlot | undefined
  gapAboveUnits: number
  gapBelowUnits: number
}): NativeChatAnswerCardEdges | undefined {
  if (!isAnswerRow(slot)) {
    return undefined
  }
  const joinsAbove = isAnswerRow(previous) && previous.turnKey === slot.turnKey
  const joinsBelow = isAnswerRow(next) && next.turnKey === slot.turnKey
  return sharedEdges({
    joinsAbove,
    joinsBelow,
    aboveUnits: joinsAbove ? 0 : clearOutset(gapAboveUnits),
    belowUnits: joinsBelow ? gapBelowUnits : clearOutset(gapBelowUnits)
  })
}

/** Leaves at least one unit, or half of a tighter gap, between the card and a row outside it;
 *  over rows that overlap, the card stops where the neighbouring row begins. */
function clearOutset(gapUnits: number): number {
  return gapUnits < 0 ? gapUnits : Math.max(0, Math.min(OUTSET_UNITS, gapUnits - 1, gapUnits / 2))
}

// Rows are memoized by prop identity, so equal edges must be the same object across renders.
const edgesByKey = new Map<string, NativeChatAnswerCardEdges>()

function sharedEdges(edges: NativeChatAnswerCardEdges): NativeChatAnswerCardEdges {
  const key = `${edges.joinsAbove}|${edges.joinsBelow}|${edges.aboveUnits}|${edges.belowUnits}`
  const shared = edgesByKey.get(key)
  if (shared) {
    return shared
  }
  edgesByKey.set(key, edges)
  return edges
}

/** Edges for the row at `index`, from the same margin rules the list applies to its rows. */
export function nativeChatAnswerCardAt(
  slots: readonly NativeChatTranscriptSlot[],
  index: number,
  rows: {
    joinsActivityAbove: (index: number) => boolean
    newRowsMarkerBelow: (index: number) => boolean
  }
): NativeChatAnswerCardEdges | undefined {
  const slot = slots[index]
  if (!isAnswerRow(slot)) {
    return undefined
  }
  const previous = slots[index - 1]
  const next = slots[index + 1]
  const gapAboveUnits = nativeChatRowGapUnits(
    previous !== undefined &&
      nativeChatSlotTucksNextRow(previous, rows.newRowsMarkerBelow(index - 1)),
    rows.joinsActivityAbove(index)
  )
  const gapBelowUnits = nativeChatRowGapUnits(
    nativeChatSlotTucksNextRow(slot, rows.newRowsMarkerBelow(index)),
    next !== undefined && rows.joinsActivityAbove(index + 1)
  )
  return nativeChatAnswerCardEdges({ slot, previous, next, gapAboveUnits, gapBelowUnits })
}
