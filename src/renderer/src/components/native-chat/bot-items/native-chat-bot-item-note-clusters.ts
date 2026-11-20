// Consecutive quiet item lines sit 4 px apart, not a full row gap: after slot selection, adjacent item
// note slots join one slot (each note keeps its own row and id inside it; a lone note is a slot of one). A note with an owner's
// comment, a receipt or turn bar, or anything drawn below a note (a turn's diff or PR card) ends it.
// A long run splits into slots of a few notes that close the row gap between them, so the window
// mounts only the notes near the view: a busy bot's hidden quiet turns join its notes across turns.
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
  continuesNotes: boolean
): NativeChatMessageSlot {
  const head = members[0]!
  const last = members.at(-1)!
  const scale = typography?.spacingScale ?? 1
  const gaps = (members.length - 1) * NATIVE_CHAT_ITEM_NOTE_GAP_PX * scale
  // The next slot's notes follow 4 px below, not a row gap below: the row draws that much shorter.
  const pulledUp = continuesNotes
    ? (NATIVE_CHAT_ROW_GAP_PX - NATIVE_CHAT_ITEM_NOTE_GAP_PX) * scale
    : 0
  return {
    ...head,
    itemNotes: members.map((member): NativeChatMessage => member.message),
    ...(continuesNotes ? { continuesNotes } : {}),
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
  const flush = (continuesNotes = false) => {
    if (members.length > 0) {
      // A lone note takes the same shape, so a neighbour joining it doesn't remount it.
      result.push(clusterSlot(members, typography, continuesNotes))
      members = []
    }
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
