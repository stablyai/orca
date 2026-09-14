// One transcript slot per row the reader can actually see.
//
// Without windowing "a message that draws nothing" costs nothing: React renders
// null and the flex column lays out what's left. With windowing every entry is a
// counted index that reserves estimated height, so a message the list counts and
// the row declines to draw becomes a gap in the transcript. This module is the
// single place that answers "does this message take a slot?", and it answers it
// with the same derivation the row itself renders from.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../shared/native-chat-turn-status'
import type { StructuredAgentSessionQueuedSend } from '../../../../shared/structured-agent-session-queued-sends'
import { nativeChatRowRendersContent } from './native-chat-row-content'
import {
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics
} from './native-chat-row-height-estimate'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from './native-chat-turn-diffs'

export type NativeChatTranscriptSlot = {
  message: NativeChatMessage
  turnKey: string | undefined
  /** The row's own turn is the one still running, so its tools stay live. */
  activeTurnIsWorking: boolean
  /** Resolved approval/question stands in for the message it answered. */
  receipt: NativeChatResolvedPrompt | undefined
  /** Turn timing shown under this row, already filtered to "should render". */
  status: NativeChatTurnStatus | undefined
  /** Set while the provider has this send queued and has started no turn for it. */
  queued: StructuredAgentSessionQueuedSend | undefined
  turnDiff: NativeChatTurnDiff | undefined
  /** Height to reserve before the row has ever been measured. */
  estimatedHeight: number
}

export type NativeChatTranscriptSlotsInput = {
  messages: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
  latestUserIndex: number
  currentTurnKey: string | undefined
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt>
  turnStatuses: {
    active: NativeChatTurnStatus | null
    completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
  }
  turnDiffs: ReadonlyMap<string, NativeChatTurnDiff>
  /** Queued sends keyed by the journal key of the row each one renders as. */
  queuedSends: ReadonlyMap<string, StructuredAgentSessionQueuedSend>
  showTurnStatus: boolean
  isWorking: boolean
  /** Session-level lifecycle, which outlives a transcript that never said "done". */
  lifecycleWorking: boolean
}

export function buildNativeChatTranscriptSlots(
  input: NativeChatTranscriptSlotsInput
): NativeChatTranscriptSlot[] {
  const {
    messages,
    turnKeys,
    latestUserIndex,
    currentTurnKey,
    receipts,
    turnStatuses,
    turnDiffs,
    queuedSends,
    showTurnStatus,
    isWorking,
    lifecycleWorking
  } = input
  const slots: NativeChatTranscriptSlot[] = []
  for (const [index, message] of messages.entries()) {
    const turnKey = turnKeys[index]
    const receipt = receipts.get(message.id)
    const candidateStatus =
      index === latestUserIndex
        ? turnStatuses.active
        : message.role === 'user' && turnKey
          ? turnStatuses.completedByTurn[turnKey]
          : undefined
    const status =
      showTurnStatus && candidateStatus?.workedSeconds != null ? candidateStatus : undefined
    const turnDiff = turnKey && turnKeys[index + 1] !== turnKey ? turnDiffs.get(turnKey) : undefined
    const queued = showTurnStatus ? queuedSends.get(message.id) : undefined
    const drawsRow = receipt !== undefined || nativeChatRowRendersContent(message.blocks)
    if (!drawsRow && status === undefined && turnDiff === undefined && queued === undefined) {
      continue
    }
    slots.push({
      message,
      turnKey,
      activeTurnIsWorking:
        showTurnStatus &&
        (currentTurnKey ? turnKey === currentTurnKey : turnKey === undefined) &&
        (isWorking || lifecycleWorking),
      receipt,
      status: status ?? undefined,
      queued,
      turnDiff,
      estimatedHeight: estimateNativeChatRowHeight(nativeChatRowContentMetrics(message), {
        hasReceipt: receipt !== undefined,
        hasStatus: status !== undefined,
        hasQueued: queued !== undefined,
        hasTurnDiff: turnDiff !== undefined
      })
    })
  }
  return slots
}

/** Slot index of a message id, or -1. Reveal targets arrive as ids because the
 *  row that owns them may not be mounted to be pointed at. */
export function nativeChatSlotIndexOf(
  slots: readonly NativeChatTranscriptSlot[],
  messageId: string | undefined
): number {
  if (messageId === undefined) {
    return -1
  }
  return slots.findIndex((slot) => slot.message.id === messageId)
}
