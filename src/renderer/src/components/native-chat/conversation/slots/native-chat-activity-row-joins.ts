// The transcript's one spacing rule for one-line activity rows (item lines, worker updates, Started
// rows): two that meet sit 4 px apart, wherever a slot or turn boundary falls between them. Anything
// else (a bubble, the agent's words, a turn's bar, diff or PR card) keeps the full row gap. A slot
// that meets the activity row above is born pulled up into the row gap, so its estimate is right
// from the first draw.
import { botItemNoteIsQuiet } from '../../../../../../shared/bots/bot-item-note-lines'
import type { BotItemNoteView } from '../../../../../../shared/bots/bot-item-note'
import {
  NATIVE_CHAT_ROW_GAP_PX,
  type NativeChatRowTypography
} from '../../viewport/virtualization/native-chat-row-height-estimate'
import type { NativeChatTimedRow } from './native-chat-timed-rows'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** The space between two activity rows that meet, as `gap-1` draws it. */
export const NATIVE_CHAT_ACTIVITY_ROW_GAP_PX = 4

type ActivityEdges = { top: boolean; bottom: boolean }

const NO_EDGES: ActivityEdges = { top: false, bottom: false }

/** A note's quiet lines draw first; the owner's comments draw after them, as messages. */
function noteEdges(note: BotItemNoteView): ActivityEdges {
  if (botItemNoteIsQuiet(note)) {
    return { top: true, bottom: true }
  }
  return { top: note.entries.some((entry) => entry.event === 'status'), bottom: false }
}

/** Whether the slot's first and last drawn things are one-line activity rows. */
function activityEdges(slot: NativeChatTranscriptSlot | undefined): ActivityEdges {
  if (
    slot?.kind !== 'message' ||
    !slot.drawsMessage ||
    slot.folded ||
    slot.receipt !== undefined ||
    slot.workRun !== undefined
  ) {
    return NO_EDGES
  }
  const { message } = slot
  const notes = slot.itemNotes ?? (message.botItemNote ? [message] : [])
  const edges: ActivityEdges =
    notes.length > 0
      ? {
          top: noteEdges(notes[0]!.botItemNote!).top,
          bottom: noteEdges(notes.at(-1)!.botItemNote!).bottom
        }
      : message.from !== undefined && (message.role === 'user' || message.agentStart === true)
        ? { top: true, bottom: true }
        : NO_EDGES
  const bar = slot.status !== undefined
  return {
    top: edges.top && !(bar && slot.statusAbove),
    bottom:
      edges.bottom &&
      !(bar && !slot.statusAbove) &&
      slot.turnDiff === undefined &&
      slot.openedPullRequests === undefined
  }
}

/** Marks each slot that opens on an activity row right below another (`followsActivity`). */
export function markNativeChatActivityJoins(
  slots: readonly NativeChatTranscriptSlot[],
  typography: NativeChatRowTypography | undefined
): void {
  const pulledUp =
    (NATIVE_CHAT_ROW_GAP_PX - NATIVE_CHAT_ACTIVITY_ROW_GAP_PX) * (typography?.spacingScale ?? 1)
  let previousBottom = false
  for (const slot of slots) {
    const edges = activityEdges(slot)
    if (slot.kind === 'message' && previousBottom && edges.top) {
      slot.followsActivity = true
      slot.estimatedHeight -= pulledUp
    }
    previousBottom = edges.bottom
  }
}

/**
 * Whether a slot that opens on an activity row draws pulled up against the one above. Only when row
 * meets row: a timed row drawn under the slot before (an approval card) or the "New" marker on
 * either row keeps the whole row gap. A row that fades out whole keeps it too, as its negative margin
 * would pass through to the window's wrapper rather than shorten the row.
 */
export function nativeChatSlotJoinsActivityAbove({
  slot,
  previous,
  timedRowsAfter,
  markerKey,
  leavesWhole
}: {
  slot: NativeChatTranscriptSlot
  previous: NativeChatTranscriptSlot | undefined
  timedRowsAfter: ReadonlyMap<string, readonly NativeChatTimedRow[]> | undefined
  markerKey: string | undefined
  leavesWhole: boolean
}): boolean {
  if (slot.kind !== 'message' || slot.followsActivity !== true || leavesWhole) {
    return false
  }
  if (previous?.kind !== 'message') {
    return false
  }
  if (
    markerKey !== undefined &&
    (markerKey === slot.message.id || markerKey === previous.message.id)
  ) {
    return false
  }
  return !(previous.itemNotes ?? [previous.message]).some(
    (member) => (timedRowsAfter?.get(member.id)?.length ?? 0) > 0
  )
}
