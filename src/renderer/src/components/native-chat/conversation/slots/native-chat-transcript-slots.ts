// Count only rendered rows: virtualized entries reserve height even when React would render null.

import type {
  NativeChatMessage,
  NativeChatSubagentEntry
} from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../shared/native-chat/transcript/native-chat-turn-status'
import { isNativeChatRowInLiveWorkingTurn } from '../../../../../../shared/native-chat/transcript/native-chat-live-turn-membership'
import { nativeChatTurnBarRows } from '../../../../../../shared/native-chat/transcript/native-chat-turn-grouping'
import {
  nativeChatTurnFold,
  nativeChatTurnFoldRow
} from '../../../../../../shared/native-chat/transcript/native-chat-turn-fold'
import { nativeChatRowRendersContent } from '../../../../../../shared/native-chat/transcript/native-chat-row-content'
import { nativeChatGeneratedImageAnswers } from '../../../../../../shared/native-chat/transcript/native-chat-generated-image-answers'
import { nativeChatMarkdownImageSources } from '../../markdown/native-chat-markdown-image-sources'
import {
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics,
  NATIVE_CHAT_SUBAGENT_HEAD_PX
} from '../../viewport/virtualization/native-chat-row-height-estimate'
import type { NativeChatResolvedPrompt } from '../../../../../../shared/native-chat/native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type { NativeChatOpenedPullRequest } from '../../../../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import type { NativeChatSubagentHead } from '../../subagents/native-chat-subagent-scope'
import { compareNativeChatDisplayMessages as compareMessages } from '../../../../../../shared/native-chat/transcript/native-chat-message-order'
import { isGeneratedImageOperation } from '../../../../../../shared/native-chat/native-chat-generated-image'
import {
  nativeChatRowRendersProse,
  nativeChatRowSpeaksOrActs
} from '../../../../../../shared/native-chat/native-chat-trailing-run'
import { nativeChatTranscriptWorkRuns } from '../../tools/runs/native-chat-transcript-work-runs'
import {
  nativeChatAgentRowHasImages,
  nativeChatAgentRowWords
} from '../../messages/rows/native-chat-message-row-words'

import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'
import {
  nativeChatSideChatForkPoint,
  nativeChatSlotOffersFork,
  type NativeChatSideChatForkPoint
} from '../../messages/actions/native-chat-side-chat-fork-point'
import { markNativeChatResponseActionsHang } from './native-chat-response-actions-hang'
import type { Translate } from '../../../../i18n/use-translate'

export type NativeChatTranscriptSlot = NativeChatMessageSlot | NativeChatSubagentHeadSlot

/** Opens a subagent no loaded roster row names, at its first row. */
export type NativeChatSubagentHeadSlot = {
  kind: 'subagent'
  agentId: string
  /** The conversation turn the head sits in, so the outline rail can place it. */
  turnKey: string | undefined
  /** The roster's entry for the agent; absent when no roster names it. */
  entry: NativeChatSubagentEntry | undefined
  estimatedHeight: number
}

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
  /** In a turn: whether this row holds its response actions, even when tools or thoughts follow:
   *  the last drawn response with words, else the last with images. Absent outside a turn. */
  endsResponse?: boolean
  /** This response is the newest one in the conversation. */
  latestResponse?: boolean
  /** Response controls under this row may hang into the gap below it: the row draws nothing after
   *  its message, and what follows is the person's own right-aligned bubble or nothing. Absent when
   *  something left-side follows (an agent's card, a notice, a task or subagent row, the turn's bar,
   *  diff rollup or PR card), where the controls keep their own height. */
  actionsHang?: boolean
  turnDiff: NativeChatTurnDiff | undefined
  /** Pull requests this row's turn opened, drawn after it. */
  openedPullRequests?: readonly NativeChatOpenedPullRequest[]
  estimatedHeight: number
  /** Members of an unbroken work run, with message as its head. */
  workRun?: readonly NativeChatMessage[]
}

const NO_SUBAGENT_HEADS: readonly NativeChatSubagentHead[] = []

export function buildNativeChatTranscriptSlots(
  input: NativeChatTranscriptSlotsInput,
  t?: Translate
): NativeChatTranscriptSlot[] {
  return buildNativeChatTranscript(input, t).slots
}

/** The transcript's slots and, when asked (`forkOffer`), where a side chat forks. */
export function buildNativeChatTranscript(
  input: NativeChatTranscriptSlotsInput,
  t?: Translate
): {
  slots: NativeChatTranscriptSlot[]
  forkPoint: NativeChatSideChatForkPoint | null
} {
  const {
    messages: sourceMessages,
    imageSources = nativeChatMarkdownImageSources,
    unresolvedRowIds,
    typography,
    turnKeys,
    liveTurnKey,
    receipts,
    turnStatuses,
    turnDiffs,
    openedPullRequests: openedPullRequestsByTurn,
    expandedTurnKeys,
    isWorking,
    lifecycleWorking,
    subagentHeads = NO_SUBAGENT_HEADS,
    liveReasoningId = null,
    forkOffer
  } = input
  const settledTurnKeys = new Set(
    Object.entries(turnStatuses.completedByTurn)
      .filter(([, status]) => status.workedSeconds != null)
      .map(([turnKey]) => turnKey)
  )
  const messages = nativeChatGeneratedImageAnswers(
    sourceMessages,
    turnKeys,
    settledTurnKeys,
    imageSources
  )
  // Share row rendering facts with fold selection so answer detection agrees with visible prose.
  const foldRows = messages.map((message, index) =>
    nativeChatTurnFoldRow(message, turnKeys[index], receipts.has(message.id))
  )
  // Liveness follows the turn frontier, not a call’s stale running flag.
  const trailingRunIndex = messages.findLastIndex((message) =>
    nativeChatRowSpeaksOrActs(message, nativeChatRowRendersProse(message), receipts)
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
  let nextHead = 0
  /** Heads whose first row comes before `message`; undefined flushes the rest. */
  const pushHeadsBefore = (message: NativeChatMessage | undefined): void => {
    for (; nextHead < subagentHeads.length; nextHead += 1) {
      const head = subagentHeads[nextHead]!
      if (message !== undefined && compareMessages(head.first.message, message) >= 0) {
        return
      }
      slots.push({
        kind: 'subagent',
        agentId: head.agentId,
        turnKey: head.first.turnKey,
        entry: head.entry,
        estimatedHeight: NATIVE_CHAT_SUBAGENT_HEAD_PX * (typography?.spacingScale ?? 1)
      })
    }
  }
  for (const [index, message] of messages.entries()) {
    pushHeadsBefore(message)
    const turnKey = turnKeys[index]
    const receipt = receipts.get(message.id)
    const bar = turnKey === undefined ? undefined : bars.get(turnKey)
    // A turn's bar draws at its first row, so a message folded into it (a steer) carries none.
    const status =
      turnKey === undefined || bar?.index !== index
        ? undefined
        : turnKey === liveTurnKey
          ? (turnStatuses.active ?? undefined)
          : (turnStatuses.completedByTurn[turnKey] ?? undefined)
    const endsTurn = turnKey !== undefined && lastRowByTurn.get(turnKey) === index
    const turnDiff = endsTurn ? turnDiffs.get(turnKey) : undefined
    const openedPullRequests = endsTurn ? openedPullRequestsByTurn?.get(turnKey) : undefined
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
      (!folded &&
        (message.agentStart || nativeChatRowRendersContent(message.blocks)) &&
        message.id !== liveReasoningId)
    if (
      drawsRow ||
      status !== undefined ||
      turnDiff !== undefined ||
      openedPullRequests !== undefined
    ) {
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
        openedPullRequests,
        estimatedHeight: estimateNativeChatRowHeight(
          nativeChatRowContentMetrics(message, typography),
          {
            hasReceipt: receipt !== undefined,
            hasStatus: status !== undefined,
            hasTurnDiff: turnDiff !== undefined,
            turnDiffFileCount: turnDiff?.files.length,
            openedPullRequestCount: openedPullRequests?.length,
            folded
          },
          typography
        )
      })
    }
  }
  pushHeadsBefore(undefined)
  const drawn = nativeChatTranscriptWorkRuns(slots, typography)
  // One action holder per turn: its last drawn response with words, else (when folding hid them)
  // its last drawn image response. Tools and thoughts never hold them.
  const lastWordsByTurn = new Map<string, NativeChatMessageSlot>()
  const lastImageByTurn = new Map<string, NativeChatMessageSlot>()
  let newestOffered: NativeChatMessageSlot | undefined
  for (const slot of drawn) {
    if (slot.kind !== 'message') {
      continue
    }
    if (forkOffer && nativeChatSlotOffersFork(slot, forkOffer)) {
      newestOffered = slot
    }
    if (slot.turnKey === undefined) {
      continue
    }
    slot.endsResponse = false
    if (!slot.drawsMessage || slot.message.role !== 'assistant') {
      continue
    }
    if (
      !slot.message.blocks.some(isGeneratedImageOperation) &&
      nativeChatAgentRowWords(slot.message, t).length > 0
    ) {
      lastWordsByTurn.set(slot.turnKey, slot)
    } else if (nativeChatAgentRowHasImages(slot.message, t)) {
      lastImageByTurn.set(slot.turnKey, slot)
    }
  }
  for (const slot of lastWordsByTurn.values()) {
    slot.endsResponse = true
  }
  for (const [turnKey, slot] of lastImageByTurn) {
    if (!lastWordsByTurn.has(turnKey)) {
      slot.endsResponse = true
    }
  }
  const latestResponse = drawn.findLast(
    (slot) =>
      slot.kind === 'message' &&
      slot.drawsMessage &&
      !slot.receipt &&
      slot.message.role === 'assistant' &&
      (slot.endsResponse === true ||
        (slot.endsResponse === undefined && nativeChatAgentRowWords(slot.message, t).length > 0))
  )
  if (latestResponse?.kind === 'message') {
    latestResponse.latestResponse = true
  }
  for (let index = 0; index < drawn.length - 1; index += 1) {
    const slot = drawn[index]!
    const next = drawn[index + 1]!
    if (
      slot.kind === 'message' &&
      next.kind === 'message' &&
      slot.turnKey !== undefined &&
      next.turnKey === slot.turnKey &&
      // The agent's own next step, not a notice or task row that trails its answer.
      (next.message.role === 'assistant' || next.message.role === 'reasoning') &&
      next.drawsMessage
    ) {
      slot.continuesTurn = true
    }
  }
  markNativeChatResponseActionsHang(drawn, typography)
  return {
    slots: drawn,
    forkPoint: forkOffer
      ? nativeChatSideChatForkPoint(newestOffered, isWorking || lifecycleWorking)
      : null
  }
}
