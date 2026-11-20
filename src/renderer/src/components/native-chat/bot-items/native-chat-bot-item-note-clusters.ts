// Consecutive quiet item lines sit 4 px apart, not a full row gap: after slot selection, adjacent item
// note slots join one slot (each note keeps its own row and id inside it; a lone note is a slot of one). A note with an owner's
// comment, a receipt or turn bar, or anything drawn below a note (a turn's diff or PR card) ends it.
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { botItemNoteIsQuiet } from '../../../../../shared/bots/bot-item-note-lines'
import type { NativeChatRowTypography } from '../viewport/virtualization/native-chat-row-height-estimate'
import type {
  NativeChatMessageSlot,
  NativeChatTranscriptSlot
} from '../conversation/slots/native-chat-transcript-slots'

/** The space between two item lines of a cluster, as `gap-1` draws it. */
export const NATIVE_CHAT_ITEM_NOTE_GAP_PX = 4

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
  const gaps = (members.length - 1) * NATIVE_CHAT_ITEM_NOTE_GAP_PX * (typography?.spacingScale ?? 1)
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
    members.push(slot)
    if (endsCluster(slot)) {
      flush()
    }
  }
  flush()
  return result
}
