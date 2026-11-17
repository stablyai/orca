import { useMemo } from 'react'
import {
  rowsBesideStreamedText,
  createStreamedTextRowProjection
} from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
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

/** Find rows by id even when unmounted; work-run members resolve to their containing slot. */
export function nativeChatSlotIndexOf(
  slots: readonly NativeChatTranscriptSlot[],
  messageId: string | undefined
): number {
  if (messageId === undefined) {
    return -1
  }
  const base = rowsBesideStreamedText(slots)
  let indexes = indexesBySlots.get(base)
  if (!indexes) {
    indexes = new Map()
    base.forEach((slot, index) => {
      if (slot.kind === 'message') {
        if (!indexes!.has(slot.message.id)) {
          indexes!.set(slot.message.id, index)
        }
        slot.workRun?.forEach((member) => {
          if (!indexes!.has(member.id)) {
            indexes!.set(member.id, index)
          }
        })
      }
    })
    indexesBySlots.set(base, indexes)
  }
  return indexes.get(messageId) ?? -1
}

const indexesBySlots = new WeakMap<readonly NativeChatTranscriptSlot[], Map<string, number>>()

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

/** Compute waiting membership from structural rows, then patch only changed slots. */
export function createNativeChatWaitingSlotProjection() {
  let held: {
    base: readonly NativeChatTranscriptSlot[]
    items: readonly AgentJournalRenderItem[] | undefined
    submissions: readonly AgentJournalSubmission[] | undefined
    stopping: boolean
    turn: unknown
    working: unknown
    own: (rows: readonly NativeChatTranscriptSlot[]) => NativeChatTranscriptSlot[]
    waiting: (rows: readonly NativeChatTranscriptSlot[]) => NativeChatTranscriptSlot[]
  } | null = null
  return (
    slots: readonly NativeChatTranscriptSlot[],
    journalItems: readonly AgentJournalRenderItem[] | undefined,
    stopping = false,
    submissions?: readonly AgentJournalSubmission[],
    host: Parameters<typeof nativeChatMessagesWaitingBehindLiveTurn>[4] = {}
  ) => {
    const base = rowsBesideStreamedText(slots)
    const items = journalItems && rowsBesideStreamedText(journalItems)
    if (
      !held ||
      held.base !== base ||
      held.items !== items ||
      held.submissions !== submissions ||
      held.stopping !== stopping ||
      held.turn !== host.latestTurn ||
      held.working !== host.working
    ) {
      const split = splitNativeChatSlotsWaitingBehindLiveTurn(
        base,
        items,
        stopping,
        submissions,
        host
      )
      const waiting = new Set(split.waitingSlots)
      held = {
        base,
        items,
        submissions,
        stopping,
        turn: host.latestTurn,
        working: host.working,
        own: createStreamedTextRowProjection((slot, index) =>
          waiting.has(base[index]!) ? null : slot
        ),
        waiting: createStreamedTextRowProjection((slot, index) =>
          waiting.has(base[index]!) ? slot : null
        )
      }
    }
    return { slots: held.own(slots), waitingSlots: held.waiting(slots) }
  }
}

const keysBySlots = new WeakMap<readonly NativeChatTranscriptSlot[], string[]>()
export function nativeChatSlotKeys(slots: readonly NativeChatTranscriptSlot[]): string[] {
  const base = rowsBesideStreamedText(slots)
  let keys = keysBySlots.get(base)
  if (!keys) {
    keys = base.map(nativeChatSlotKey)
    keysBySlots.set(base, keys)
  }
  return keys
}
export function useNativeChatWaitingSlots(
  ...args: Parameters<ReturnType<typeof createNativeChatWaitingSlotProjection>>
) {
  const split = useMemo(() => createNativeChatWaitingSlotProjection(), [])
  return split(...args)
}
