import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../../../../shared/native-chat/transcript/turns/native-chat-messages-waiting-behind-live-turn'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

export function nativeChatSlotKey(slot: NativeChatTranscriptSlot): string {
  switch (slot.kind) {
    case 'message':
      return slot.message.id
    case 'subagent':
      return `subagent-head:${slot.agentId}`
  }
}

/** Find rows by id even when unmounted; work-run and item-note members resolve to their slot. */
export function nativeChatSlotIndexOf(
  slots: readonly NativeChatTranscriptSlot[],
  messageId: string | undefined
): number {
  return messageId === undefined
    ? -1
    : slots.findIndex(
        (slot) =>
          slot.kind === 'message' &&
          (slot.message.id === messageId ||
            (slot.workRun ?? slot.itemNotes)?.some((member) => member.id === messageId) === true)
      )
}

/**
 * The collapsed turn that hides `messageId`: the message is in `messages` (aligned with
 * `turnKeys`), its turn is not expanded, and no slot draws it. Undefined otherwise.
 */
export function nativeChatFoldedTurnOf(
  slots: readonly NativeChatTranscriptSlot[],
  messages: readonly { id: string }[],
  turnKeys: readonly (string | undefined)[],
  expandedTurnKeys: ReadonlySet<string>,
  messageId: string
): string | undefined {
  const turnKey = turnKeys[messages.findIndex((message) => message.id === messageId)]
  if (turnKey === undefined || expandedTurnKeys.has(turnKey)) {
    return undefined
  }
  const slot = slots[nativeChatSlotIndexOf(slots, messageId)]
  return slot?.kind === 'message' && slot.drawsMessage ? undefined : turnKey
}

/** Place queued and unjournaled not-sent messages after live activity, outside its turn. */
export function splitNativeChatSlotsWaitingBehindLiveTurn(
  slots: readonly NativeChatTranscriptSlot[],
  journalItems: readonly AgentJournalRenderItem[] | undefined,
  stopping = false,
  journalSubmissions?: readonly AgentJournalSubmission[],
  host: Parameters<typeof nativeChatMessagesWaitingBehindLiveTurn>[4] = {}
): { slots: NativeChatTranscriptSlot[]; waitingSlots: NativeChatTranscriptSlot[] } {
  const waiting = nativeChatMessagesWaitingBehindLiveTurn(
    slots.flatMap((slot) => (slot.kind === 'message' ? [slot.message] : [])),
    journalItems,
    stopping,
    journalSubmissions,
    host
  )
  const isWaiting = (slot: NativeChatTranscriptSlot): boolean =>
    slot.kind === 'message' &&
    (waiting.has(slot.message.id) ||
      (slot.message.unsent === true && slot.message.journalPosition === undefined))
  const waitingSlots: NativeChatTranscriptSlot[] = []
  const transcriptSlots = slots.filter((slot) => {
    if (isWaiting(slot)) {
      waitingSlots.push(slot)
      return false
    }
    return true
  })
  return { slots: transcriptSlots, waitingSlots }
}
