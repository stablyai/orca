import type { AgentJournalCursor } from '../journal/agent-session-journal-identity'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../journal/agent-session-journal-types'
import type { StructuredAgentSubmission } from './structured-agent-session-submissions'
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
import {
  agentSessionContextSequenceFor,
  isAgentSessionContextClear
} from '../conversation-context/agent-session-context-clear'

/** Client echo until host publication; an acknowledged read past recordedCursor supersedes it. */
export type StructuredAgentSessionOptimisticMessage = {
  clientMessageId: string
  body: AgentJournalMessageItem
  /** Null when this client did not make the send and nothing dates it. */
  queuedAt: number | null
  delivery?: 'queue-if-active'
  phase?: 'sending' | 'recorded' | 'unconfirmed'
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

/** Rejected sends shown as unsent in submission order; withdrawals use stop notices, queued handoffs/cards keep their cards,
 * and commands carry rejection in their own reply. `resent`: rejected sends a later copy stands in for. */
export function structuredAgentSessionRejectedShownInPlace(
  submissions: readonly StructuredAgentSubmission[],
  commandItemIds: ReadonlySet<string>,
  clearSequences: readonly number[] = []
): { shown: Set<string>; resent: Set<string> } {
  const latest = new Map<string, number>()
  const later = Array.from<number | undefined>({ length: submissions.length })
  const scopeKey = (submission: StructuredAgentSubmission) =>
    JSON.stringify([
      agentSessionContextSequenceFor(submission.acceptedSequence ?? 0, clearSequences),
      submission.payloadFingerprint
    ])
  for (let index = submissions.length - 1; index >= 0; index--) {
    const submission = submissions[index]
    const key = scopeKey(submission)
    later[index] = latest.get(key)
    if (!dispatchWasWithdrawn(submission)) {
      latest.set(key, Math.max(latest.get(key) ?? -Infinity, submission.submittedAt))
    }
  }
  const shown = new Set<string>()
  const resent = new Set<string>()
  for (const [index, submission] of submissions.entries()) {
    const { resolvedAt } = submission
    if (
      submission.dispatchState !== 'rejected' ||
      dispatchWasWithdrawn(submission) ||
      // Persist card ownership on the send so editing/deleting the card cannot resurrect its row.
      agentJournalSubmissionReturnedToCard(submission) ||
      commandItemIds.has(agentJournalSubmissionKey(submission.clientMessageId))
    ) {
      continue
    }
    // Collapses resends of a rejected message: past Retries resent it under a new id, and the
    // host re-delivers its own messages under new ids. Only a later copy sent once the rejection
    // was known counts, so a repeat sent before it is kept.
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    if (resolvedAt !== null && later[index] !== undefined && later[index] >= resolvedAt) {
      resent.add(key)
    } else {
      shown.add(key)
    }
  }
  return { shown, resent }
}

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
  submissions: readonly StructuredAgentSubmission[],
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
  submissions: readonly StructuredAgentSubmission[],
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
  // Other rejections are ledger-only unless explicitly shown in place as unsent.
  const rejected = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
      .filter((itemId) => !stoppedBeforeStart.has(itemId))
  )
  // Avoid placement work on every stream commit when no stopped sends exist.
  const placement =
    stoppedBeforeStart.size > 0 ? placeStoppedSends(items, submissions, stoppedBeforeStart) : null
  const { shown: inPlace, resent } = structuredAgentSessionRejectedShownInPlace(
    submissions,
    structuredAgentSessionCommandItemIds(items),
    items.filter((item) => isAgentSessionContextClear(item.body)).map((item) => item.sequence)
  )
  const replacedFailures = resent.size > 0 ? startFailureRowsAfter(items, resent) : resent
  const visibleItems: AgentJournalRenderItem[] = []
  const unsentItems: AgentJournalRenderItem[] = []
  for (const item of items) {
    if (inPlace.has(item.itemId)) {
      unsentItems.push(item)
    } else if (!rejected.has(item.itemId) && !replacedFailures.has(item.itemId)) {
      visibleItems.push(item)
    }
  }
  const journalled = new Set(visibleItems.map((item) => item.itemId))
  const submissionsByItemId = new Map(
    submissions.map((submission) => [
      agentJournalSubmissionKey(submission.clientMessageId),
      submission
    ])
  )
  const marks = automationResultMarks(visibleItems)
  const delivered: NativeChatMessage[] = []
  const held: NativeChatMessage[] = []
  const shownStopped = new Set<string>()
  let moved = false
  for (const row of projectItems(visibleItems)) {
    const submission = submissionsByItemId.get(row.id)
    const message: NativeChatMessage =
      submission?.dispatchState === 'pending' || submission?.dispatchState === 'unknown'
        ? {
            ...row,
            deliveryState: submission.dispatchState,
            ...(submission.queuedMessageId ? { queuedMessageId: submission.queuedMessageId } : {})
          }
        : submission?.queuedMessageId && row.from
          ? deliveredAgentMailRow(row, submission.queuedMessageId)
          : row
    // Until handover, queued sends have no conversation position.
    if (
      submission &&
      submission.queuedMessageId === undefined &&
      isQueuedAgentJournalSubmission(submission)
    ) {
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
  const output = [
    ...placed,
    // Held cards follow the conversation outside its runs.
    ...held,
    // Host rows supersede client echoes under either client or provider IDs.
    ...structuredAgentSessionEchoRows(optimistic, journalled, submissionsByItemId)
  ]
  return {
    output,
    conversationEnd: placed.length,
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
