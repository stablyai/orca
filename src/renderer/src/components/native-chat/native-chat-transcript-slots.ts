// One transcript slot per row the reader can actually see.
//
// Without windowing "a message that draws nothing" costs nothing: React renders
// null and the flex column lays out what's left. With windowing every entry is a
// counted index that reserves estimated height, so a message the list counts and
// the row declines to draw becomes a gap in the transcript. This module is the
// single place that answers "does this message take a slot?", and it answers it
// with the same derivation the row itself renders from.

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { AGENT_SESSION_ORCA_STOP_PRESENTATION } from '../../../../shared/agent-session-orca-stop'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../shared/native-chat-turn-status'
import { isNativeChatRowInLiveWorkingTurn } from '../../../../shared/native-chat-turn-membership'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../../shared/native-chat-messages-waiting-behind-live-turn'
import { nativeChatTurnBarRows } from '../../../../shared/native-chat-turn-grouping'
import {
  nativeChatTurnFold,
  type NativeChatTurnFoldRow
} from '../../../../shared/native-chat-turn-fold'
import { nativeChatRowRendersContent } from '../../../../shared/native-chat-row-content'
import { isStoppedBeforeStartBlock } from '../../../../shared/native-chat-stopped-before-start'
import {
  type NativeChatRowTypography,
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics
} from './native-chat-row-height-estimate'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from './native-chat-turn-diffs'
import {
  NO_NATIVE_CHAT_SUBAGENT_CHOICES,
  NO_NATIVE_CHAT_SUBAGENT_SECTIONS,
  type NativeChatSubagentChoices,
  type NativeChatSubagentRosterState,
  type NativeChatSubagentSections
} from './native-chat-subagent-sections'
import { nativeChatSubagentLiveSections } from './native-chat-subagent-live-frontier'
import {
  nativeChatSubagentSectionSlots,
  type NativeChatSubagentEntriesSlot,
  type NativeChatSubagentSectionSlot
} from './native-chat-subagent-section-slots'
import { nativeChatRowRendersProse, nativeChatRowSpeaksOrActs } from './native-chat-trailing-run'
import { nativeChatTranscriptWorkRuns } from './native-chat-transcript-work-runs'

export type NativeChatTranscriptSlot =
  | NativeChatMessageSlot
  | NativeChatSubagentSectionSlot
  | NativeChatSubagentEntriesSlot

export type NativeChatMessageSlot = {
  kind: 'message'
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
  /** Whether the message itself draws. False when the slot is here only for its turn's bar or diff
   *  rollup: a folded or empty row, or the open block the live line shows. */
  drawsMessage: boolean
  /** Whether this row's turn hides anything, so its status row offers a caret. */
  turnFolds: boolean
  turnDiff: NativeChatTurnDiff | undefined
  /** On a roster row: whether its list is open, and the subagents whose sections open
   *  under their entries, each with whether it is open. A closed list draws none of them. */
  subagentRoster: NativeChatSubagentRosterState | undefined
  /** Subagent sections this row sits inside; 0 is the conversation. */
  depth: number
  /** Height to reserve before the row has ever been measured. */
  estimatedHeight: number
  /** Set when this row draws an unbroken stretch of tool calls and thoughts as one run:
   *  every message in it, `message` first. */
  workRun?: readonly NativeChatMessage[]
}

export type NativeChatTranscriptSlotsInput = {
  messages: readonly NativeChatMessage[]
  typography?: NativeChatRowTypography
  turnKeys: readonly (string | undefined)[]
  /** The live turn (`nativeChatTurnMembership`): its bar carries the running clock and its rows
   *  stay live. Undefined when no row has opened one. */
  liveTurnKey: string | undefined
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
  subagentSections?: NativeChatSubagentSections
  subagentChoices?: NativeChatSubagentChoices
  /** The open reasoning block the live activity line discloses: its row takes no slot meanwhile. */
  liveReasoningId?: string | null
}

export function buildNativeChatTranscriptSlots(
  input: NativeChatTranscriptSlotsInput
): NativeChatTranscriptSlot[] {
  const {
    messages,
    typography,
    turnKeys,
    liveTurnKey,
    receipts,
    turnStatuses,
    turnDiffs,
    expandedTurnKeys,
    isWorking,
    lifecycleWorking,
    subagentSections: sections = NO_NATIVE_CHAT_SUBAGENT_SECTIONS,
    subagentChoices: choices = NO_NATIVE_CHAT_SUBAGENT_CHOICES,
    liveReasoningId = null
  } = input
  // One pass to decide what each row draws, then the fold over those readings —
  // so "is this the answer" and "does this row render prose" cannot disagree.
  const foldRows: NativeChatTurnFoldRow[] = messages.map((message, index) => ({
    turnKey: turnKeys[index],
    role: message.role,
    rendersProse: nativeChatRowRendersProse(message),
    draws: receipts.has(message.id) || nativeChatRowRendersContent(message.blocks),
    // The raw blocks, not the renderable ones: a childless roster draws no row
    // and its plain-text twin is then the only record the spawn happened.
    outlivesTurn: message.blocks.some(
      (block) =>
        isSubagentGroupBlock(block) ||
        isBackgroundTaskBlock(block) ||
        isStoppedBeforeStartBlock(block)
    ),
    // A row about Orca's own stop is stored red for clients that predate it; it reports no failure.
    reportsFailure: message.blocks.some(
      (block) =>
        block.type === 'text' &&
        block.tone === 'error' &&
        block.presentation !== AGENT_SESSION_ORCA_STOP_PRESENTATION
    ),
    explainsTurn: message.blocks.some(
      (block) =>
        block.type === 'text' &&
        (block.presentation === 'compaction' ||
          block.presentation === AGENT_SESSION_ORCA_STOP_PRESENTATION)
    )
  }))
  // Liveness is the turn's, not any one call's: the run at the frontier stays
  // live between its calls, and a run the agent has moved past is settled even
  // while its last call is still reporting.
  const trailingRunIndex = foldRows.findLastIndex((row, index) =>
    nativeChatRowSpeaksOrActs(messages[index]!, row.rendersProse, receipts)
  )
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
  const bars = nativeChatTurnBarRows(messages, turnKeys)
  // A turn's rows need not be contiguous (another turn's prompt can land among
  // them), so its rollup goes under its last row, not every run boundary.
  const lastRowByTurn = new Map<string, number>()
  turnKeys.forEach((turnKey, index) => {
    if (turnKey !== undefined) {
      lastRowByTurn.set(turnKey, index)
    }
  })
  const slots: NativeChatTranscriptSlot[] = []
  const live = nativeChatSubagentLiveSections(messages, sections, isWorking || lifecycleWorking)
  const sectionSlots = nativeChatSubagentSectionSlots({
    sections,
    choices,
    live,
    receipts,
    slots,
    typography
  })
  const pending = [...(sections.openAt.get(null) ?? [])]
  for (const [index, message] of messages.entries()) {
    sectionSlots.openBefore(pending, message, 0)
    const turnKey = turnKeys[index]
    const receipt = receipts.get(message.id)
    const bar = turnKey === undefined ? undefined : bars.get(turnKey)
    // A turn's bar draws at its first row, so a message folded into it (a steer) carries none.
    const candidateStatus =
      turnKey === undefined || bar?.index !== index
        ? undefined
        : turnKey === liveTurnKey
          ? turnStatuses.active
          : turnStatuses.completedByTurn[turnKey]
    // The live turn's bar carries its running clock; it settles in place.
    const status = candidateStatus ?? undefined
    const turnDiff =
      turnKey && lastRowByTurn.get(turnKey) === index ? turnDiffs.get(turnKey) : undefined
    const folded = foldedRows.has(index)
    // Skipping a folded row entirely is what keeps windowing honest: a counted
    // index the row declines to draw reserves estimated height for nothing and
    // opens a gap in the transcript.
    const activeTurnIsWorking = isNativeChatRowInLiveWorkingTurn(
      turnKey,
      liveTurnKey,
      isWorking || lifecycleWorking
    )
    const drawsRow =
      receipt !== undefined ||
      (!folded && nativeChatRowRendersContent(message.blocks) && message.id !== liveReasoningId)
    const roster = sectionSlots.rosterAt(message.id)
    if (drawsRow || status !== undefined || turnDiff !== undefined) {
      slots.push({
        kind: 'message',
        message,
        turnKey,
        activeTurnIsWorking,
        trailingRun: index === trailingRunIndex,
        receipt,
        status: status ?? undefined,
        statusAbove: bar?.above === true && status !== undefined,
        folded,
        drawsMessage: drawsRow,
        turnFolds: turnKey !== undefined && foldableTurnKeys.has(turnKey),
        turnDiff,
        subagentRoster: roster,
        depth: 0,
        estimatedHeight: estimateNativeChatRowHeight(
          nativeChatRowContentMetrics(message, typography),
          {
            hasReceipt: receipt !== undefined,
            hasStatus: status !== undefined,
            hasTurnDiff: turnDiff !== undefined,
            folded
          },
          typography
        )
      })
    }
    sectionSlots.openAnchoredAt(message, roster, turnKey)
  }
  sectionSlots.openBefore(pending, undefined, 0)
  return nativeChatTranscriptWorkRuns(slots, typography)
}

/** Stable key for a slot: its message id, the agent whose section it heads, or its
 *  roster row and first entry. */
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

/** Slot index of a message id, or -1, counting a work run's members as its row. Reveal
 *  targets arrive as ids because the row that owns them may not be mounted to be pointed at. */
export function nativeChatSlotIndexOf(
  slots: readonly NativeChatTranscriptSlot[],
  messageId: string | undefined
): number {
  if (messageId === undefined) {
    return -1
  }
  return slots.findIndex(
    (slot) =>
      slot.kind === 'message' &&
      (slot.message.id === messageId ||
        slot.workRun?.some((member) => member.id === messageId) === true)
  )
}

/** Splits off the slots of messages waiting behind the live turn, and of ones shown as not sent
 *  that the journal holds no place for: they draw after the live activity, not inside it. */
export function splitNativeChatSlotsWaitingBehindLiveTurn(
  slots: readonly NativeChatTranscriptSlot[],
  journalItems: readonly AgentJournalRenderItem[] | undefined,
  stopping = false,
  journalSubmissions?: readonly AgentJournalSubmission[]
): { slots: NativeChatTranscriptSlot[]; waitingSlots: NativeChatTranscriptSlot[] } {
  const waiting = nativeChatMessagesWaitingBehindLiveTurn(
    slots.flatMap((slot) => (slot.kind === 'message' ? [slot.message] : [])),
    journalItems,
    stopping,
    journalSubmissions
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
