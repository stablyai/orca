// Consecutive quiet item lines sit 4 px apart, not a full row gap: after slot selection, adjacent item
// note slots join one slot (each note keeps its own row and id inside it; a lone note is a slot of one). A note with an owner's
// comment, a receipt or turn bar, or anything drawn below a note (a turn's diff or PR card) ends it.
// A long run splits into slots of a few notes, so the window mounts only the notes near the view (a
// busy bot's hidden quiet turns join its notes across turns). Each slot after the first pulls up into
// the row gap to sit 4 px below the one before; it is born that way, so a note joining the run never
// reshapes a slot already drawn, or one the window has measured and let go.
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { botItemNoteIsQuiet } from '../../../../../shared/bots/bot-item-note-lines'
import {
  NATIVE_CHAT_ROW_GAP_PX,
  type NativeChatRowTypography
} from '../viewport/virtualization/native-chat-row-height-estimate'
import type {
  NativeChatMessageSlot,
  NativeChatTranscriptSlot
} from '../conversation/slots/native-chat-transcript-slots'
import type { NativeChatTimedRow } from '../conversation/slots/native-chat-timed-rows'

/** The space between two item lines of a cluster, as `gap-1` draws it. */
export const NATIVE_CHAT_ITEM_NOTE_GAP_PX = 4

/** Notes per slot. Counted from a run's first note, so a live note only changes the last slot. */
export const MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER = 8

function quietNote(slot: NativeChatTranscriptSlot): slot is NativeChatMessageSlot {
  const note = slot.kind === 'message' ? slot.message.botItemNote : undefined
  return (
    slot.kind === 'message' &&
    note !== undefined &&
    slot.drawsMessage &&
    !slot.folded &&
    slot.receipt === undefined &&
    slot.status === undefined &&
    botItemNoteIsQuiet(note)
  )
}

function endsCluster(slot: NativeChatMessageSlot): boolean {
  return slot.turnDiff !== undefined || slot.openedPullRequests !== undefined
}

function clusterSlot(
  members: readonly NativeChatMessageSlot[],
  typography: NativeChatRowTypography | undefined,
  followsNotes: boolean
): NativeChatMessageSlot {
  const head = members[0]!
  const last = members.at(-1)!
  const scale = typography?.spacingScale ?? 1
  const gaps = (members.length - 1) * NATIVE_CHAT_ITEM_NOTE_GAP_PX * scale
  // Drawn 4 px below the slot before rather than a row gap below: the row measures that much shorter.
  const pulledUp = followsNotes
    ? (NATIVE_CHAT_ROW_GAP_PX - NATIVE_CHAT_ITEM_NOTE_GAP_PX) * scale
    : 0
  return {
    ...head,
    itemNotes: members.map((member): NativeChatMessage => member.message),
    ...(followsNotes ? { followsNotes } : {}),
    trailingRun: members.some((member) => member.trailingRun),
    turnDiff: last.turnDiff,
    openedPullRequests: last.openedPullRequests,
    estimatedHeight: members.reduce((sum, member) => sum + member.estimatedHeight, gaps) - pulledUp
  }
}

export function nativeChatBotItemNoteClusters(
  slots: readonly NativeChatTranscriptSlot[],
  typography?: NativeChatRowTypography
): NativeChatTranscriptSlot[] {
  const result: NativeChatTranscriptSlot[] = []
  let members: NativeChatMessageSlot[] = []
  // Whether the slot being gathered carries on the run of the slot before it.
  let follows = false
  const flush = (runGoesOn = false) => {
    if (members.length > 0) {
      // A lone note takes the same shape, so a neighbour joining it doesn't remount it.
      result.push(clusterSlot(members, typography, follows))
      members = []
    }
    follows = runGoesOn
  }
  for (const slot of slots) {
    if (!quietNote(slot)) {
      flush()
      result.push(slot)
      continue
    }
    if (members.length === MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER) {
      flush(true)
    }
    members.push(slot)
    if (endsCluster(slot)) {
      flush()
    }
  }
  flush()
  return result
}

/**
 * Whether a slot that carries on a run of notes draws pulled up against the slot before. Only when
 * note meets note: a timed row drawn under the slot before (an approval card) or the "New" marker on
 * either row keeps the whole row gap. A row that fades out whole keeps it too, as its negative margin
 * would pass through to the window's wrapper rather than shorten the row.
 */
export function nativeChatSlotJoinsNotesAbove({
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
  if (slot.kind !== 'message' || slot.followsNotes !== true || leavesWhole || slot.statusAbove) {
    return false
  }
  if (previous?.kind !== 'message' || !previous.itemNotes) {
    return false
  }
  if (
    markerKey !== undefined &&
    (markerKey === slot.message.id || markerKey === previous.message.id)
  ) {
    return false
  }
  return !previous.itemNotes.some((member) => (timedRowsAfter?.get(member.id)?.length ?? 0) > 0)
}
