import { structuredAgentSessionRejectedShownInPlace } from './structured-agent-session-rejected-projection'
import type { AgentJournalCursor } from '../journal/agent-session-journal-identity'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { selectAgentSessionCurrentRequests } from '../requests/agent-session-current-requests'
import {
  agentJournalSubmissionReturnedToCard,
  isQueuedAgentJournalSubmission
} from '../requests/agent-session-queued-submission'
import { collapseProviderRetryRuns } from '../../native-chat/transcript/notices/native-chat-provider-retry-runs'
import {
  keepStoppedSendsInSendOrder,
  placeStoppedSends,
  withStopRowsAfterStoppedSends
} from '../../native-chat/transcript/pending-sends/native-chat-stopped-before-start'
import { compareNativeChatTranscriptMessages } from '../../native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../native-chat/native-chat-types'
import { dispatchWasWithdrawn } from '../requests/structured-agent-session-dispatch-rejection'
import { isStructuredAgentSessionStartFailureRow } from '../failures/structured-agent-session-start-failure-row-key'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'
import {
  deliveredAgentMailRow,
  structuredAgentSessionEchoRows
} from './structured-agent-session-echo-rows'
import {
  automationResultMarks,
  withAutomationResultMarks
} from '../../bots/bot-automation-result-marks'
import { isActionableStructuredAgentSessionPrompt } from './structured-agent-session-live-turn'
import { isAgentSessionContextClear } from '../conversation-context/agent-session-context-clear'
import {
  structuredAgentSessionNewerRejection,
  structuredAgentSessionRetryLineages,
  structuredAgentSessionRetryRow
} from './structured-agent-session-retry-lineage'

/** Client echo until host publication; an acknowledged read past recordedCursor supersedes it. */
export type StructuredAgentSessionOptimisticMessage = {
  retryOfClientMessageId?: string
  clientMessageId: string
  body: AgentJournalMessageItem
  /** Null when this client did not make the send and nothing dates it. */
  queuedAt: number | null
  phase?: 'sending' | 'recorded' | 'unconfirmed'
  retainedSendId?: string
  recordedCursor?: AgentJournalCursor
  /** In-memory placement captured at Send, independent of any acknowledgement. */
  afterSequence?: number
  options?: Readonly<Record<string, string>>
  /** Sent while the chat read Stopping: drawn after the turn being stopped. */
  sentWhileStopping?: true
}

export function structuredAgentSessionCommandItemIds(
  items: readonly AgentJournalRenderItem[]
): Set<string> {
  return new Set(
    items
      .filter((item) => item.body.kind === 'message' && item.body.command)
      .map((item) => item.itemId)
  )
}

export function structuredAgentSessionClearSequences(
  items: readonly AgentJournalRenderItem[]
): number[] {
  return items.filter((item) => isAgentSessionContextClear(item.body)).map((item) => item.sequence)
}

export { structuredAgentSessionRejectedShownInPlace }

/** Start-failure rows answering these sends: after one, before the next send. The resend's own
 *  outcome replaces them, as its copy replaces the send. */
function startFailureRowsAfter(
  items: readonly AgentJournalRenderItem[],
  sends: ReadonlySet<string>
): Set<string> {
  const rows = new Set<string>()
  let after = false
  for (const item of items) {
    if (item.body.kind === 'message' && item.body.role === 'user' && isRootAgentJournalItem(item)) {
      after = sends.has(item.itemId)
    } else if (after && isStructuredAgentSessionStartFailureRow(item.itemId)) {
      rows.add(item.itemId)
    }
  }
  return rows
}

export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly AgentJournalSubmission[],
  projectItems = projectStructuredItemsToNativeChat
): NativeChatMessage[] {
  return projectStructuredAgentSessionMessageRows(items, optimistic, submissions, projectItems)
    .output
}

export type StructuredAgentSessionItemProjector = (
  items: readonly AgentJournalRenderItem[]
) => NativeChatMessage[]

export type StructuredAgentSessionMessageRows = {
  output: NativeChatMessage[]
  /** Rows before the held cards and optimistic echoes. */
  conversationEnd: number
  hasStoppedSends: boolean
}

export function projectStructuredAgentSessionMessageRows(
  items: readonly AgentJournalRenderItem[],
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly AgentJournalSubmission[],
  projectItems: StructuredAgentSessionItemProjector
): StructuredAgentSessionMessageRows {
  // Keep stopped-before-start sends in conversation history; queued handoffs stay in their cards.
  const stoppedBeforeStart = new Map(
    submissions
      .filter(
        (submission) => dispatchWasWithdrawn(submission) && submission.queuedMessageId === undefined
      )
      .map((submission) => [agentJournalSubmissionKey(submission.clientMessageId), submission])
  )
  // Avoid placement work on every stream commit when no stopped sends exist.
  const placement =
    stoppedBeforeStart.size > 0 ? placeStoppedSends(items, submissions, stoppedBeforeStart) : null
  const { shown: inPlace, resent } = structuredAgentSessionRejectedShownInPlace(
    submissions,
    structuredAgentSessionCommandItemIds(items),
    structuredAgentSessionClearSequences(items)
  )
  const replacedFailures = resent.size > 0 ? startFailureRowsAfter(items, resent) : resent
  const visibleItems: AgentJournalRenderItem[] = []
  const unsentItems: AgentJournalRenderItem[] = []
  let pendingDelivery: Map<string, 'pending' | 'unknown'> | undefined
  let itemIds: Set<string> | undefined
  const hasItem = (id: string): boolean =>
    (itemIds ??= new Set(items.map((item) => item.itemId))).has(id)
  const submissionsByItemId = new Map<string, AgentJournalSubmission>()
  const lineages = structuredAgentSessionRetryLineages(submissions)
  for (const submission of submissions) {
    submissionsByItemId.set(agentJournalSubmissionKey(submission.clientMessageId), submission)
  }
  for (const item of items) {
    const { itemId } = item
    const send = submissionsByItemId.get(itemId)
    const root = send && (send.retryOfClientMessageId ?? send.clientMessageId)
    const retry = root ? lineages.get(root) : undefined
    let state = send?.dispatchState
    if (
      send &&
      retry &&
      root &&
      (state !== 'accepted' || send.clientMessageId === retry.clientMessageId)
    ) {
      const retainedOriginal = retry.dispatchState === 'unknown' && send.clientMessageId === root
      if (
        !retainedOriginal &&
        itemId !==
          structuredAgentSessionRetryRow(
            root,
            retry,
            hasItem,
            submissionsByItemId.get(agentJournalSubmissionKey(root)),
            stoppedBeforeStart.has(agentJournalSubmissionKey(retry.clientMessageId))
          )
      ) {
        continue
      }
      if (!retainedOriginal) {
        state = retry.dispatchState
      }
      if (state === 'rejected' && send.retryOfClientMessageId && !stoppedBeforeStart.has(itemId)) {
        if (!agentJournalSubmissionReturnedToCard(send) && !resent.has(itemId)) {
          unsentItems.push(item)
        }
        continue
      }
    }
    if (state === 'rejected' && inPlace.has(itemId)) {
      unsentItems.push(item)
    } else if (
      (state !== 'rejected' || stoppedBeforeStart.has(itemId)) &&
      !replacedFailures.has(itemId)
    ) {
      if (state === 'pending' || state === 'unknown') {
        ;(pendingDelivery ??= new Map()).set(itemId, state)
      }
      visibleItems.push(item)
    }
  }
  const journalled = new Set([...visibleItems, ...unsentItems].map(({ itemId }) => itemId))
  const marks = automationResultMarks(visibleItems)
  const delivered: NativeChatMessage[] = []
  const held: NativeChatMessage[] = []
  const shownStopped = new Set<string>()
  let moved = false
  for (const row of projectItems(visibleItems)) {
    const submission = submissionsByItemId.get(row.id)
    const queuedMessageId = submission?.queuedMessageId
    const deliveryState = pendingDelivery?.get(row.id)
    const message: NativeChatMessage = deliveryState
      ? { ...row, deliveryState, ...(queuedMessageId ? { queuedMessageId } : {}) }
      : queuedMessageId && row.from
        ? deliveredAgentMailRow(row, queuedMessageId)
        : row
    // Until handover, queued sends have no conversation position.
    if (submission && queuedMessageId === undefined && isQueuedAgentJournalSubmission(submission)) {
      held.push({ ...message, queued: true })
    } else if (!placement || !stoppedBeforeStart.has(message.id)) {
      delivered.push(withAutomationResultMarks(message, marks))
    } else {
      const { opensTurn, position } = placement(message.id)
      moved ||= position !== undefined
      // An opener’s interrupted turn already reports its stop; do not add another notice.
      if (!opensTurn) {
        shownStopped.add(message.id)
      }
      delivered.push({
        ...message,
        stoppedBeforeStart: true,
        ...(position ? { journalPosition: position } : {})
      })
    }
  }
  if (shownStopped.size > 0) {
    moved = keepStoppedSendsInSendOrder(delivered, stoppedBeforeStart, shownStopped) || moved
  }
  const ordered = moved
    ? Array.from(collapseProviderRetryRuns(delivered)).sort(compareNativeChatTranscriptMessages)
    : collapseProviderRetryRuns(delivered)
  const conversation =
    shownStopped.size > 0 ? withStopRowsAfterStoppedSends(ordered, shownStopped) : ordered
  // Merge unsent rows at journal positions after stop grouping so each run retains one stop notice.
  const placed =
    unsentItems.length > 0
      ? withRowsAtJournalPlaces(
          conversation,
          projectItems(unsentItems).map((message) => ({ ...message, unsent: true as const }))
        )
      : conversation
  const uncertainRoots = new Set<string>()
  const echoes = structuredAgentSessionEchoRows(
    optimistic.filter((entry) => {
      const root = entry.retryOfClientMessageId
      if (!root) {
        return true
      }
      const retry = lineages.get(root)
      if (retry?.dispatchState === 'accepted') {
        return false
      }
      const rootItem = agentJournalSubmissionKey(root)
      const retryIsVisible =
        retry !== undefined && journalled.has(agentJournalSubmissionKey(retry.clientMessageId))
      return entry.phase === 'unconfirmed'
        ? retry?.dispatchState !== 'pending' &&
            (!(retryIsVisible || journalled.has(rootItem)) ||
              !structuredAgentSessionNewerRejection(retry, entry.queuedAt))
        : !hasItem(rootItem) && !retryIsVisible
    }),
    journalled,
    submissionsByItemId,
    uncertainRoots
  )
  // An uncertain retry replaces the prior failure only when it actually has an echo.
  const rows = uncertainRoots.size
    ? placed.filter((row) => {
        const send = submissionsByItemId.get(row.id)
        return (
          !row.unsent ||
          !send ||
          !uncertainRoots.has(send.retryOfClientMessageId ?? send.clientMessageId)
        )
      })
    : placed
  return {
    output: [...rows, ...held, ...echoes],
    conversationEnd: rows.length,
    hasStoppedSends: stoppedBeforeStart.size > 0
  }
}

/** Merge placed rows in journal order so clients rendering the list directly need no sort. */
function withRowsAtJournalPlaces(
  rows: readonly NativeChatMessage[],
  placed: NativeChatMessage[]
): NativeChatMessage[] {
  placed.sort(compareNativeChatTranscriptMessages)
  const merged: NativeChatMessage[] = []
  let next = 0
  for (const row of rows) {
    while (next < placed.length && compareNativeChatTranscriptMessages(placed[next], row) < 0) {
      merged.push(placed[next++])
    }
    merged.push(row)
  }
  return merged.concat(placed.slice(next))
}

export type StructuredPromptItem = AgentJournalRenderItem & {
  body: Extract<AgentJournalRenderItem['body'], { kind: 'approval' | 'question' }>
}

/** Offer pending prompts, respecting the host’s actionable-wait declaration when available. */
export function pendingStructuredSessionPrompts({
  journalItems,
  currentRequests,
  actionablePromptIds
}: {
  journalItems: readonly AgentJournalRenderItem[]
  currentRequests?: readonly AgentJournalRenderItem[]
  actionablePromptIds?: readonly string[]
}): StructuredPromptItem[] {
  return selectAgentSessionCurrentRequests({ items: journalItems, currentRequests }).filter(
    (item): item is StructuredPromptItem =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending' &&
      isActionableStructuredAgentSessionPrompt(item.itemId, actionablePromptIds)
  )
}
