import { nativeChatSlotKey } from '../../conversation/slots/native-chat-transcript-slot-selection'
// Combine calls/thoughts after slot selection so every intervening visible row ends the run.

import { agentJournalItemSubagentId } from '../../../../../../shared/agent-session/journal/agent-session-journal-producer'
import {
  nativeChatWorkRunMember,
  nativeChatWorkRunSpans,
  type NativeChatWorkRunRow
} from '../../../../../../shared/native-chat/transcript/folding/native-chat-work-run'
import {
  type NativeChatRowTypography,
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics,
  nativeChatWorkRunContentMetrics
} from '../../viewport/virtualization/native-chat-row-height-estimate'
import type {
  NativeChatMessageSlot,
  NativeChatTranscriptSlot
} from '../../conversation/slots/native-chat-transcript-slots'

function workRunRow(slot: NativeChatTranscriptSlot): NativeChatWorkRunRow {
  if (slot.kind !== 'message') {
    return { member: null, draws: true, scope: undefined }
  }
  return {
    member: slot.drawsMessage
      ? // The live line owns the open thought.
        nativeChatWorkRunMember(slot.message, slot.receipt !== undefined, false)
      : null,
    draws: true,
    scope: `${agentJournalItemSubagentId(slot.message)}:${slot.turnKey}`
  }
}

function workRunSlot(
  members: readonly NativeChatMessageSlot[],
  headIsLead: boolean,
  typography: NativeChatRowTypography | undefined
): NativeChatMessageSlot {
  const head = members[0]!
  // A turn's bar sits on its first row and its rollup on its last, so the run takes each from there.
  const { turnDiff, openedPullRequests } = members.at(-1)!
  return {
    ...head,
    workRun: members.map((member) => member.message),
    trailingRun: members.some((member) => member.trailingRun),
    turnDiff,
    openedPullRequests,
    estimatedHeight: estimateNativeChatRowHeight(
      nativeChatWorkRunContentMetrics(
        nativeChatRowContentMetrics(head.message, typography),
        headIsLead
      ),
      {
        hasReceipt: false,
        hasStatus: head.status !== undefined,
        hasTurnDiff: turnDiff !== undefined,
        turnDiffFileCount: turnDiff?.files.length,
        hasOpenedPullRequests: (openedPullRequests?.length ?? 0) > 0
      },
      typography
    )
  }
}

const NO_PREVIOUS_OWNERS: ReadonlyMap<string, string> = new Map()

export function nativeChatTranscriptWorkRuns(
  slots: readonly NativeChatTranscriptSlot[],
  typography?: NativeChatRowTypography,
  previousOwners: ReadonlyMap<string, string> = NO_PREVIOUS_OWNERS
): { slots: NativeChatTranscriptSlot[]; owners: ReadonlyMap<string, string> } {
  const previousKeys = new Set(previousOwners.values())
  const reserved = new Set<string>()
  const rows = slots.map((slot) => {
    if (previousKeys.size > 0) {
      const key = nativeChatSlotKey(slot)
      if (previousKeys.has(key)) {
        reserved.add(key)
      }
    }
    return workRunRow(slot)
  })
  const runAt = new Map<number, NativeChatMessageSlot[]>()
  const joined = new Set<number>()
  for (const span of nativeChatWorkRunSpans(rows)) {
    runAt.set(
      span[0]!,
      span.flatMap((index) => {
        const slot = slots[index]
        return slot?.kind === 'message' ? [slot] : []
      })
    )
    for (const index of span.slice(1)) {
      joined.add(index)
    }
  }
  const result: NativeChatTranscriptSlot[] = []
  const claimed = new Set<string>()
  const owners = new Map<string, string>()
  for (const [index, source] of slots.entries()) {
    if (joined.has(index)) {
      continue
    }
    const members = runAt.get(index)
    const slot = members ? workRunSlot(members, rows[index]?.member === 'lead', typography) : source
    if (slot.kind !== 'message' || rows[index]?.member === null) {
      result.push(slot)
      continue
    }
    const messages = slot.workRun ?? [slot.message]
    let key = slot.message.id
    for (const member of messages) {
      const previous = previousOwners.get(member.id)
      if (
        previous !== undefined &&
        !claimed.has(previous) &&
        (!reserved.has(previous) || messages.some((message) => message.id === previous))
      ) {
        key = previous
        break
      }
    }
    claimed.add(key)
    for (const member of messages) {
      owners.set(member.id, key)
    }
    result.push(key === slot.message.id ? slot : { ...slot, presentationKey: key })
  }
  return { slots: result, owners }
}
