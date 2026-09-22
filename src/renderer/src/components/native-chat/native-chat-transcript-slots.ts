// One transcript slot per row the reader can actually see.
//
// Without windowing "a message that draws nothing" costs nothing: React renders
// null and the flex column lays out what's left. With windowing every entry is a
// counted index that reserves estimated height, so a message the list counts and
// the row declines to draw becomes a gap in the transcript. This module is the
// single place that answers "does this message take a slot?", and it answers it
// with the same derivation the row itself renders from.

import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../shared/native-chat-turn-status'
import {
  nativeChatTurnFold,
  type NativeChatTurnFoldRow
} from '../../../../shared/native-chat-turn-fold'
import { deriveNativeChatRowContent, nativeChatRowRendersContent } from './native-chat-row-content'
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
  /** This row is behind its turn's folded status row: it draws no prose and no
   *  tool activity, only work that outlives the turn. */
  folded: boolean
  /** Whether this row's turn hides anything, so its status row offers a caret. */
  turnFolds: boolean
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
  showTurnStatus: boolean
  /** Turns the reader opened. Everything else with a duration stays folded. */
  expandedTurnKeys: ReadonlySet<string>
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
    showTurnStatus,
    expandedTurnKeys,
    isWorking,
    lifecycleWorking
  } = input
  // One pass to decide what each row draws, then the fold over those readings —
  // so "is this the answer" and "does this row render prose" cannot disagree.
  const foldRows: NativeChatTurnFoldRow[] = messages.map((message, index) => {
    const content = deriveNativeChatRowContent(message.blocks)
    return {
      turnKey: turnKeys[index],
      role: message.role,
      rendersProse: content.markdown.length > 0 || content.hasImages,
      // The raw blocks, not the renderable ones: a childless roster draws no row
      // and its plain-text twin is then the only record the spawn happened.
      outlivesTurn: message.blocks.some(
        (block) => isSubagentGroupBlock(block) || isBackgroundTaskBlock(block)
      )
    }
  })
  const settledTurnKeys = new Set(
    showTurnStatus
      ? Object.entries(turnStatuses.completedByTurn)
          .filter(([, status]) => status.workedSeconds != null)
          .map(([turnKey]) => turnKey)
      : []
  )
  const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
    rows: foldRows,
    settledTurnKeys,
    expandedTurnKeys
  })
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
    const folded = foldedRows.has(index)
    // Skipping a folded row entirely is what keeps windowing honest: a counted
    // index the row declines to draw reserves estimated height for nothing and
    // opens a gap in the transcript.
    const drawsRow =
      receipt !== undefined || (!folded && nativeChatRowRendersContent(message.blocks))
    if (!drawsRow && status === undefined && turnDiff === undefined) {
      continue
    }
    slots.push({
      message,
      turnKey,
      activeTurnIsWorking:
        (currentTurnKey ? turnKey === currentTurnKey : turnKey === undefined) &&
        (isWorking || lifecycleWorking),
      receipt,
      status: status ?? undefined,
      folded,
      turnFolds: turnKey !== undefined && foldableTurnKeys.has(turnKey),
      turnDiff,
      estimatedHeight: estimateNativeChatRowHeight(nativeChatRowContentMetrics(message), {
        hasReceipt: receipt !== undefined,
        hasStatus: status !== undefined,
        hasTurnDiff: turnDiff !== undefined,
        folded
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
