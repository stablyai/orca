import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../../shared/native-chat/transcript/native-chat-messages-waiting-behind-live-turn'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

export function nativeChatSlotKey(slot: NativeChatTranscriptSlot): string {
  switch (slot.kind) {
    case 'message':
      return slot.message.id
    case 'subagent':
      return `subagent-section:${slot.agentId}`
    case 'subagent-entries':
      return `subagent-entries:${slot.rosterRowId}:${slot.agents[0]?.id}`
  }
}

/** Find rows by id even when unmounted; work-run members resolve to their containing slot. */
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
            slot.workRun?.some((member) => member.id === messageId) === true)
      )
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
