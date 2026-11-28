import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../../../../shared/native-chat/transcript/turns/native-chat-messages-waiting-behind-live-turn'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import { positionsRevisedFrom } from '../../../../../../shared/agent-session/view/revised-in-place-lists'
import {
  noteStreamedTextStage,
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
        nativeChatSlotKey(slot) === messageId ||
        (slot.kind === 'message' &&
          (slot.workRun ?? slot.itemNotes)?.some((member) => member.id === messageId) === true)
    )
    indexes.set(messageId, index)
  }
  return index
}

/** The row at an index, by the key `nativeChatSlotIndexOf` finds it again by: a message, or a subagent's header. */
export function nativeChatSlotKeyAt(
  slots: readonly NativeChatTranscriptSlot[],
  index: number
): string | null {
  const slot = slots[index]
  return slot ? nativeChatSlotKey(slot) : null
}

type WaitingInputs = readonly unknown[]

type WaitingSplit = {
  slots: readonly NativeChatTranscriptSlot[]
  waitingSlots: readonly NativeChatTranscriptSlot[]
}

const NOTHING_WAITING: readonly NativeChatTranscriptSlot[] = []

// Per laid-out slot list: the inputs that placed its waiting slots, their keys, and, once a slot
// waits, the laid-out split, each slot's place in its transcript slots (-1 waiting), and the split
// last given for a streamed revision of it.
const waitingSplits = new WeakMap<
  readonly NativeChatTranscriptSlot[],
  {
    inputs: WaitingInputs
    keys: ReadonlySet<string>
    split?: WaitingSplit
    placeOf?: readonly number[]
    last?: { slots: readonly NativeChatTranscriptSlot[]; split: WaitingSplit }
  }
>()

function splitByKeys(
  slots: readonly NativeChatTranscriptSlot[],
  keys: ReadonlySet<string>
): WaitingSplit & { placeOf: number[] } {
  const waitingSlots: NativeChatTranscriptSlot[] = []
  const transcriptSlots: NativeChatTranscriptSlot[] = []
  const placeOf = slots.map((slot) => {
    if (keys.has(nativeChatSlotKey(slot))) {
      waitingSlots.push(slot)
      return -1
    }
    transcriptSlots.push(slot)
    return transcriptSlots.length - 1
  })
  return { slots: transcriptSlots, waitingSlots, placeOf }
}

/** Place queued and unjournaled not-sent messages after live activity, outside its turn. A
 *  streamed text revision waits as its base did, so it is placed without a scan: its transcript
 *  slots replace only the revised ones and stay linked to the laid-out split. */
export function splitNativeChatSlotsWaitingBehindLiveTurn(
  slots: readonly NativeChatTranscriptSlot[],
  journalItems: readonly AgentJournalRenderItem[] | undefined,
  stopping = false,
  journalSubmissions?: readonly AgentJournalSubmission[],
  host: Parameters<typeof nativeChatMessagesWaitingBehindLiveTurn>[4] = {}
): WaitingSplit {
  const laidOut = stageBesideStreamedText(slots)
  const inputs: WaitingInputs = [
    journalItems && rowsBesideStreamedText(journalItems),
    stopping,
    journalSubmissions,
    host.latestTurn,
    host.working
  ]
  let entry = waitingSplits.get(laidOut)
  if (
    !entry ||
    entry.inputs.length !== inputs.length ||
    !entry.inputs.every((input, index) => input === inputs[index])
  ) {
    const waiting = nativeChatMessagesWaitingBehindLiveTurn(
      laidOut.flatMap((slot) => (slot.kind === 'message' ? [slot.message] : [])),
      journalItems,
      stopping,
      journalSubmissions,
      host
    )
    const keys = new Set(
      laidOut
        .filter(
          (slot) =>
            slot.kind === 'message' &&
            (waiting.has(slot.message.id) ||
              (slot.message.unsent === true && slot.message.journalPosition === undefined))
        )
        .map(nativeChatSlotKey)
    )
    entry = { inputs, keys }
    waitingSplits.set(laidOut, entry)
  }
  // Nothing waiting keeps the list itself, so a streamed text revision stays linked to its base.
  if (entry.keys.size === 0) {
    return { slots, waitingSlots: NOTHING_WAITING }
  }
  if (!entry.split || !entry.placeOf) {
    const { placeOf, ...split } = splitByKeys(laidOut, entry.keys)
    entry.split = split
    entry.placeOf = placeOf
  }
  if (slots === laidOut) {
    return entry.split
  }
  // The same slots, as when only another agent's text moved: the same split.
  if (entry.last?.slots === slots) {
    return entry.last.split
  }
  const laidOutSplit = { slots: laidOut, split: entry.split }
  // A revision of the last slots served, or of the laid-out ones when patched afresh from them.
  let from = entry.last ?? laidOutSplit
  let revisedAt = positionsRevisedFrom(slots, from.slots)
  if (!revisedAt && from !== laidOutSplit) {
    from = laidOutSplit
    revisedAt = positionsRevisedFrom(slots, laidOut)
  }
  let split: WaitingSplit | undefined
  if (revisedAt && revisedAt.every((index) => entry.placeOf![index] !== -1)) {
    const transcriptSlots = from.split.slots.slice()
    for (const index of revisedAt) {
      transcriptSlots[entry.placeOf[index]!] = slots[index]!
    }
    split = { slots: transcriptSlots, waitingSlots: from.split.waitingSlots }
  } else {
    // A waiting slot itself revised, or the revision is not known: place every slot again.
    const { placeOf: _placeOf, ...placed } = splitByKeys(slots, entry.keys)
    split = placed
  }
  noteStreamedTextStage(split.slots, entry.split.slots)
  entry.last = { slots, split }
  return split
}
