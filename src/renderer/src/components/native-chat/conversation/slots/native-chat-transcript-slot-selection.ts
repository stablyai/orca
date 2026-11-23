import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../../../../shared/native-chat/transcript/turns/native-chat-messages-waiting-behind-live-turn'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import {
  rowsBesideStreamedText,
  stageBesideStreamedText
} from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'

export function nativeChatSlotKey(slot: NativeChatTranscriptSlot): string {
  switch (slot.kind) {
    case 'message':
      return slot.message.id
    case 'subagent':
      return `subagent-head:${slot.agentId}`
  }
}

// Per slot list (a streamed text revision shares its base's), each looked-up row's slot index.
const slotIndexes = new WeakMap<readonly NativeChatTranscriptSlot[], Map<string, number>>()

/** Find rows by id even when unmounted; work-run and item-note members resolve to their slot. */
export function nativeChatSlotIndexOf(
  slots: readonly NativeChatTranscriptSlot[],
  messageId: string | undefined
): number {
  if (messageId === undefined) {
    return -1
  }
  // A streamed text revision moves no slot, so its base's indexes hold.
  const laidOut = stageBesideStreamedText(slots)
  let indexes = slotIndexes.get(laidOut)
  if (!indexes) {
    indexes = new Map()
    slotIndexes.set(laidOut, indexes)
  }
  let index = indexes.get(messageId)
  if (index === undefined) {
    index = laidOut.findIndex(
      (slot) =>
        slot.kind === 'message' &&
        (slot.message.id === messageId ||
          (slot.workRun ?? slot.itemNotes)?.some((member) => member.id === messageId) === true)
    )
    indexes.set(messageId, index)
  }
  return index
}

type WaitingInputs = readonly unknown[]

// Per laid-out slot list, the slots waiting behind the live turn and the inputs that placed them.
const waitingKeys = new WeakMap<
  readonly NativeChatTranscriptSlot[],
  { inputs: WaitingInputs; keys: ReadonlySet<string> }
>()

/** Place queued and unjournaled not-sent messages after live activity, outside its turn. A
 *  streamed text revision waits as its base did, so it is placed without a scan. */
export function splitNativeChatSlotsWaitingBehindLiveTurn(
  slots: readonly NativeChatTranscriptSlot[],
  journalItems: readonly AgentJournalRenderItem[] | undefined,
  stopping = false,
  journalSubmissions?: readonly AgentJournalSubmission[],
  host: Parameters<typeof nativeChatMessagesWaitingBehindLiveTurn>[4] = {}
): {
  slots: readonly NativeChatTranscriptSlot[]
  waitingSlots: NativeChatTranscriptSlot[]
} {
  const laidOut = stageBesideStreamedText(slots)
  const inputs: WaitingInputs = [
    journalItems && rowsBesideStreamedText(journalItems),
    stopping,
    journalSubmissions,
    host.latestTurn,
    host.working
  ]
  const cached = waitingKeys.get(laidOut)
  let keys =
    cached?.inputs.length === inputs.length &&
    cached.inputs.every((input, index) => input === inputs[index])
      ? cached.keys
      : undefined
  if (!keys) {
    const waiting = nativeChatMessagesWaitingBehindLiveTurn(
      laidOut.flatMap((slot) => (slot.kind === 'message' ? [slot.message] : [])),
      journalItems,
      stopping,
      journalSubmissions,
      host
    )
    keys = new Set(
      laidOut
        .filter(
          (slot) =>
            slot.kind === 'message' &&
            (waiting.has(slot.message.id) ||
              (slot.message.unsent === true && slot.message.journalPosition === undefined))
        )
        .map(nativeChatSlotKey)
    )
    waitingKeys.set(laidOut, { inputs, keys })
  }
  // Nothing waiting keeps the list itself, so a streamed text revision stays linked to its base.
  if (keys.size === 0) {
    return { slots, waitingSlots: [] }
  }
  const waitingSlots: NativeChatTranscriptSlot[] = []
  const transcriptSlots = slots.filter((slot) => {
    if (keys.has(nativeChatSlotKey(slot))) {
      waitingSlots.push(slot)
      return false
    }
    return true
  })
  return { slots: transcriptSlots, waitingSlots }
}
