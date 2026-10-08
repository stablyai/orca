// Draws each unbroken stretch of tool calls and thoughts as one slot. A pass over the slots
// already built, so anything else that takes a slot (a section head, a roster's entries, a
// row carrying only its turn's bar or rollup) ends a run just by sitting between its rows.

import { agentJournalItemSubagentId } from '../../../../shared/agent-session-journal-producer'
import {
  nativeChatWorkRunMember,
  nativeChatWorkRunSpans,
  type NativeChatWorkRunRow
} from '../../../../shared/native-chat-work-run'
import {
  type NativeChatRowTypography,
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics,
  nativeChatWorkRunContentMetrics
} from './native-chat-row-height-estimate'
import type {
  NativeChatMessageSlot,
  NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

function workRunRow(slot: NativeChatTranscriptSlot): NativeChatWorkRunRow {
  // Every slot draws something: its message, or its turn's bar or rollup.
  if (slot.kind !== 'message') {
    return { member: null, draws: true, scope: undefined }
  }
  return {
    member:
      slot.drawsMessage && slot.subagentRoster === undefined
        ? nativeChatWorkRunMember(
            slot.message,
            slot.receipt !== undefined,
            // At the top level the live line owns the open thought; only a section has none.
            slot.depth > 0 && slot.activeTurnIsWorking
          )
        : null,
    draws: true,
    scope: `${slot.depth}:${agentJournalItemSubagentId(slot.message)}:${slot.turnKey}`
  }
}

function workRunSlot(
  members: readonly NativeChatMessageSlot[],
  headIsLead: boolean,
  typography: NativeChatRowTypography | undefined
): NativeChatMessageSlot {
  const head = members[0]!
  // A turn's bar sits on its first row and its rollup on its last, so the run takes each from there.
  const { turnDiff } = members.at(-1)!
  return {
    ...head,
    workRun: members.map((member) => member.message),
    trailingRun: members.some((member) => member.trailingRun),
    turnDiff,
    estimatedHeight: estimateNativeChatRowHeight(
      nativeChatWorkRunContentMetrics(
        nativeChatRowContentMetrics(head.message, typography),
        headIsLead
      ),
      {
        hasReceipt: false,
        hasStatus: head.status !== undefined,
        hasTurnDiff: turnDiff !== undefined,
        inSubagentSection: head.depth > 0
      },
      typography
    )
  }
}

export function nativeChatTranscriptWorkRuns(
  slots: readonly NativeChatTranscriptSlot[],
  typography?: NativeChatRowTypography
): NativeChatTranscriptSlot[] {
  const rows = slots.map(workRunRow)
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
  for (const [index, slot] of slots.entries()) {
    const members = runAt.get(index)
    if (members) {
      result.push(workRunSlot(members, rows[index]?.member === 'lead', typography))
    } else if (!joined.has(index)) {
      result.push(slot)
    }
  }
  return result
}
