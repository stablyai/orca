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
  isToolCallBlock,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import { agentJournalItemSubagentId } from '../../../../shared/agent-session-journal-producer'
import { nativeChatSubagentLabel } from '../../../../shared/native-chat-subagent-attribution'
import {
  NATIVE_CHAT_UNANCHORED_TURN_KEY,
  type NativeChatTurnStatus
} from '../../../../shared/native-chat-turn-status'
import { nativeChatSelfAnchoredTurnRows } from '../../../../shared/native-chat-turn-grouping'
import {
  nativeChatTurnFold,
  type NativeChatTurnFoldRow
} from '../../../../shared/native-chat-turn-fold'
import {
  deriveNativeChatRowContent,
  nativeChatRowRendersContent
} from '../../../../shared/native-chat-row-content'
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
  /** Nothing the agent said or did comes after this row, so its tool run is
   *  the one still live while the turn works. A later run or answer settles it;
   *  a reasoning aside does not, the agent is still inside the same batch. */
  trailingRun: boolean
  /** Resolved approval/question stands in for the message it answered. */
  receipt: NativeChatResolvedPrompt | undefined
  /** Turn timing shown under this row, already filtered to "should render". */
  status: NativeChatTurnStatus | undefined
  /** The bar renders above the row: this turn has no user bubble of its own
   *  (provider-opened), so its bar sits at the turn's position instead. */
  statusAbove?: boolean
  /** This row is behind its turn's folded status row: it draws no prose and no
   *  tool activity, only work that outlives the turn. */
  folded: boolean
  /** Whether this row's turn hides anything, so its status row offers a caret. */
  turnFolds: boolean
  turnDiff: NativeChatTurnDiff | undefined
  /** The roster's name for the subagent that wrote this row, when one names it.
   *  Whether a subagent wrote it at all is the message's own linkage. */
  subagentLabel: string | undefined
  /** Height to reserve before the row has ever been measured. */
  estimatedHeight: number
}

export type NativeChatTranscriptSlotsInput = {
  messages: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
  /** The transcript key whose bar carries the live turn's status. */
  activeTurnKey: string
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt>
  turnStatuses: {
    active: NativeChatTurnStatus | null
    completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
  }
  turnDiffs: ReadonlyMap<string, NativeChatTurnDiff>
  /** Turns the reader opened. Everything else with a duration stays folded. */
  expandedTurnKeys: ReadonlySet<string>
  isWorking: boolean
  /** Session-level lifecycle, which outlives a transcript that never said "done". */
  lifecycleWorking: boolean
  /** Each subagent's roster label, by the id its rows carry. */
  subagentLabels?: ReadonlyMap<string, string>
}

export function buildNativeChatTranscriptSlots(
  input: NativeChatTranscriptSlotsInput
): NativeChatTranscriptSlot[] {
  const {
    messages,
    turnKeys,
    activeTurnKey,
    receipts,
    turnStatuses,
    turnDiffs,
    expandedTurnKeys,
    isWorking,
    lifecycleWorking,
    subagentLabels
  } = input
  // One pass to decide what each row draws, then the fold over those readings —
  // so "is this the answer" and "does this row render prose" cannot disagree.
  const foldRows: NativeChatTurnFoldRow[] = messages.map((message, index) => {
    const content = deriveNativeChatRowContent(message.blocks)
    const agentId = agentJournalItemSubagentId(message)
    return {
      turnKey: turnKeys[index],
      role: message.role,
      rendersProse: content.markdown.length > 0 || content.hasImages,
      // The raw blocks, not the renderable ones: a childless roster draws no row
      // and its plain-text twin is then the only record the spawn happened.
      outlivesTurn: message.blocks.some(
        (block) => isSubagentGroupBlock(block) || isBackgroundTaskBlock(block)
      ),
      ...(agentId === null ? {} : { agentId })
    }
  })
  // Liveness is the turn's, not any one call's: the run at the frontier stays
  // live between its calls, and a run the agent has moved past is settled even
  // while its last call is still reporting. An approval's receipt decides a call
  // of the run above it, which then runs, so it does not move past that run.
  // Each agent has its own frontier: a subagent working below its parent's run
  // has not moved the parent past it.
  const trailingRunIndexes = new Set<number>()
  const agentsWithFrontier = new Set<string | null>()
  for (let index = foldRows.length - 1; index >= 0; index -= 1) {
    const row = foldRows[index]!
    const agent = agentJournalItemSubagentId(messages[index])
    if (
      !agentsWithFrontier.has(agent) &&
      row.role !== 'user' &&
      row.role !== 'reasoning' &&
      receipts.get(messages[index].id)?.kind !== 'approval' &&
      (row.rendersProse || messages[index].blocks.some(isToolCallBlock))
    ) {
      trailingRunIndexes.add(index)
      agentsWithFrontier.add(agent)
    }
  }
  const settledTurnKeys = new Set(
    Object.entries(turnStatuses.completedByTurn)
      .filter(([, status]) => status.workedSeconds != null)
      .map(([turnKey]) => turnKey)
  )
  const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
    rows: foldRows,
    settledTurnKeys,
    expandedTurnKeys
  })
  // A turn with no user bubble (provider-opened) anchors its bar at its first row.
  const selfAnchors = nativeChatSelfAnchoredTurnRows(messages, turnKeys)
  // A turn's rows need not be contiguous (another turn's prompt can land among
  // them), so its rollup goes under its last row, not every run boundary.
  const lastRowByTurn = new Map<string, number>()
  turnKeys.forEach((turnKey, index) => {
    if (turnKey !== undefined) {
      lastRowByTurn.set(turnKey, index)
    }
  })
  const slots: NativeChatTranscriptSlot[] = []
  for (const [index, message] of messages.entries()) {
    const turnKey = turnKeys[index]
    const receipt = receipts.get(message.id)
    const anchorsTurnHere = turnKey !== undefined && selfAnchors.get(turnKey) === index
    // Only the bubble that opened a turn carries its bar: a message the provider
    // folded into a running turn shares the turn's key but not its bar.
    const candidateStatus =
      message.role === 'user' && message.id === activeTurnKey
        ? turnStatuses.active
        : message.role === 'user' && turnKey === message.id
          ? turnStatuses.completedByTurn[turnKey]
          : anchorsTurnHere
            ? turnKey === activeTurnKey
              ? (turnStatuses.active ?? turnStatuses.completedByTurn[turnKey])
              : turnStatuses.completedByTurn[turnKey]
            : undefined
    // The live turn's bar carries its running clock; it settles in place.
    const status = candidateStatus ?? undefined
    const turnDiff =
      turnKey && lastRowByTurn.get(turnKey) === index ? turnDiffs.get(turnKey) : undefined
    const folded = foldedRows.has(index)
    // Skipping a folded row entirely is what keeps windowing honest: a counted
    // index the row declines to draw reserves estimated height for nothing and
    // opens a gap in the transcript.
    const drawsRow =
      receipt !== undefined || (!folded && nativeChatRowRendersContent(message.blocks))
    if (!drawsRow && status === undefined && turnDiff === undefined) {
      continue
    }
    const subagentId = agentJournalItemSubagentId(message)
    slots.push({
      message,
      turnKey,
      // Liveness is the owning turn's, not the newest prompt's: a running turn's
      // rows stay live while a newer message waits behind it.
      activeTurnIsWorking:
        (turnKey === activeTurnKey ||
          (turnKey === undefined && activeTurnKey === NATIVE_CHAT_UNANCHORED_TURN_KEY)) &&
        (isWorking || lifecycleWorking),
      trailingRun: trailingRunIndexes.has(index),
      receipt,
      status: status ?? undefined,
      statusAbove: anchorsTurnHere && status !== undefined,
      folded,
      turnFolds: turnKey !== undefined && foldableTurnKeys.has(turnKey),
      turnDiff,
      subagentLabel: nativeChatSubagentLabel(subagentLabels, message),
      estimatedHeight: estimateNativeChatRowHeight(nativeChatRowContentMetrics(message), {
        hasReceipt: receipt !== undefined,
        hasStatus: status !== undefined,
        hasTurnDiff: turnDiff !== undefined,
        folded,
        // Only an agent's own row draws the caption; a receipt stands in for it.
        attributed: subagentId !== null && receipt === undefined && message.role !== 'user'
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
