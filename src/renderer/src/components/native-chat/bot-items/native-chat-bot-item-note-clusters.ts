// Consecutive quiet item notes join one slot (each note keeps its own row and id inside it; a lone note
// is a slot of one). A note with an owner's comment, a receipt or turn bar, or anything drawn below a
// note (a turn's diff or PR card) ends it. A long run splits into slots of a few notes, so the window
// mounts only the notes near the view (a busy bot's hidden quiet turns join its notes across turns);
// how close those slots sit is `markNativeChatActivityJoins`'s.
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { botItemNoteIsQuiet } from '../../../../../shared/bots/bot-item-note-lines'
import type { NativeChatRowTypography } from '../viewport/virtualization/native-chat-row-height-estimate'
import { NATIVE_CHAT_ACTIVITY_ROW_GAP_PX } from '../conversation/slots/native-chat-activity-row-joins'
import type {
  NativeChatMessageSlot,
  NativeChatTranscriptSlot
} from '../conversation/slots/native-chat-transcript-slots'

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
  typography: NativeChatRowTypography | undefined
): NativeChatMessageSlot {
  const head = members[0]!
  const last = members.at(-1)!
  const scale = typography?.spacingScale ?? 1
  const gaps = (members.length - 1) * NATIVE_CHAT_ACTIVITY_ROW_GAP_PX * scale
  return {
    ...head,
    itemNotes: members.map((member): NativeChatMessage => member.message),
    trailingRun: members.some((member) => member.trailingRun),
    turnDiff: last.turnDiff,
    openedPullRequests: last.openedPullRequests,
    estimatedHeight: members.reduce((sum, member) => sum + member.estimatedHeight, gaps)
  }
}

export function nativeChatBotItemNoteClusters(
  slots: readonly NativeChatTranscriptSlot[],
  typography?: NativeChatRowTypography
): NativeChatTranscriptSlot[] {
  const result: NativeChatTranscriptSlot[] = []
  let members: NativeChatMessageSlot[] = []
  const flush = () => {
    if (members.length > 0) {
      // A lone note takes the same shape, so a neighbour joining it doesn't remount it.
      result.push(clusterSlot(members, typography))
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
      flush()
    }
    members.push(slot)
    if (endsCluster(slot)) {
      flush()
    }
  }
  flush()
  return result
}
