// Count only rendered rows: virtualized entries reserve height even when React would render null.

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../shared/native-chat-turn-status'
import { isNativeChatRowInLiveWorkingTurn } from '../../../../shared/native-chat-turn-membership'
import { nativeChatMessagesWaitingBehindLiveTurn } from '../../../../shared/native-chat-messages-waiting-behind-live-turn'
import { nativeChatTurnBarRows } from '../../../../shared/native-chat-turn-grouping'
import { nativeChatTurnFold, nativeChatTurnFoldRow } from '../../../../shared/native-chat-turn-fold'
import { nativeChatRowRendersContent } from '../../../../shared/native-chat-row-content'
import {
  type NativeChatRowTypography,
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics
} from './native-chat-row-height-estimate'
import type { NativeChatResolvedPrompt } from '../../../../shared/native-chat-resolution-receipt'
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
import { nativeChatRowSpeaksOrActs } from '../../../../shared/native-chat/native-chat-trailing-run'
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
  /** Only newer speech/actions settle the trailing run; reasoning stays in the batch. */
  trailingRun: boolean
  /** Resolved approval/question stands in for the message it answered. */
  receipt: NativeChatResolvedPrompt | undefined
  /** Turn timing shown under this row, already filtered to "should render". */
  status: NativeChatTurnStatus | undefined
  /** Provider-opened turns have no prompt; draw their bar at the turn position. */
  statusAbove?: boolean
  /** Fold prose/tools behind turn status while retaining work that outlives the turn. */
  folded: boolean
  /** False when only turn chrome draws: empty/folded rows or reasoning owned by the live line. */
  drawsMessage: boolean
  /** Whether this row's turn hides anything, so its status row offers a caret. */
  turnFolds: boolean
  /** The agent's next row in the same turn follows directly, so the two sit close. */
  continuesTurn?: boolean
  turnDiff: NativeChatTurnDiff | undefined
  /** A closed roster list hides child sections regardless of their individual expansion state. */
  subagentRoster: NativeChatSubagentRosterState | undefined
  /** Subagent sections this row sits inside; 0 is the conversation. */
  depth: number
  estimatedHeight: number
  /** Members of an unbroken work run, with message as its head. */
  workRun?: readonly NativeChatMessage[]
}

export type NativeChatTranscriptSlotsInput = {
  messages: readonly NativeChatMessage[]
  unresolvedRowIds?: ReadonlySet<string>
  typography?: NativeChatRowTypography
  turnKeys: readonly (string | undefined)[]
  /** The current turn owns the running clock and live rows; undefined before a turn opens. */
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
    unresolvedRowIds,
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
  // Share row rendering facts with fold selection so answer detection agrees with visible prose.
  const foldRows = messages.map((message, index) =>
    nativeChatTurnFoldRow(message, turnKeys[index], receipts.has(message.id))
  )
  // Liveness follows the turn frontier, not a call’s stale running flag.
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
  // Turn rows can interleave with other prompts; emit one rollup after their last row.
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
    const status = candidateStatus ?? undefined
    const turnDiff =
      turnKey && lastRowByTurn.get(turnKey) === index ? turnDiffs.get(turnKey) : undefined
    const folded = foldedRows.has(index)
    // Exclude nondrawing folded rows so virtualized estimates cannot leave empty gaps.
    const activeTurnIsWorking = isNativeChatRowInLiveWorkingTurn(
      turnKey,
      liveTurnKey,
      isWorking || lifecycleWorking,
      unresolvedRowIds?.has(message.id)
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
  const drawn = nativeChatTranscriptWorkRuns(slots, typography)
  for (let index = 0; index < drawn.length - 1; index += 1) {
    const slot = drawn[index]!
    const next = drawn[index + 1]!
    if (
      slot.kind === 'message' &&
      next.kind === 'message' &&
      // A subagent's section keeps the transcript's gap as part of its frame.
      slot.depth === 0 &&
      next.depth === 0 &&
      slot.turnKey !== undefined &&
      next.turnKey === slot.turnKey &&
      // The agent's own next step, not a notice or task row that trails its answer.
      (next.message.role === 'assistant' || next.message.role === 'reasoning') &&
      next.drawsMessage
    ) {
      slot.continuesTurn = true
    }
  }
  return drawn
}

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
