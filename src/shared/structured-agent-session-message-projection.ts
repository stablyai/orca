import type {
  AgentJournalCursor,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { collapseProviderRetryRuns } from './native-chat/native-chat-provider-retry-runs'
import {
  keepStoppedSendsInSendOrder,
  placeStoppedSends,
  withStopRowsAfterStoppedSends
} from './native-chat-stopped-before-start'
import { compareNativeChatTranscriptMessages } from './native-chat-transcript-projection'
import type { NativeChatMessage } from './native-chat-types'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'
import {
  agentSessionContextSequenceFor,
  isAgentSessionContextClear
} from './agent-session-context-clear'

/** Client echo until host publication; an acknowledged read past recordedCursor supersedes it. */
export type StructuredAgentSessionOptimisticMessage = {
  clientMessageId: string
  body: AgentJournalMessageItem
  queuedAt: number
  recordedCursor?: AgentJournalCursor
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
 * and commands carry rejection in their own reply. */
export function structuredAgentSessionRejectedShownInPlace(
  submissions: readonly AgentJournalSubmission[],
  commandItemIds: ReadonlySet<string>,
  clearSequences: readonly number[] = []
): Set<string> {
  // Track copies by body/scope; withdrawals supersede no failed copy.
  const copies = new Map<string, { index: number; submittedAt: number }[]>()
  const scopeKey = (submission: AgentJournalSubmission) =>
    JSON.stringify([
      agentSessionContextSequenceFor(submission.acceptedSequence ?? 0, clearSequences),
      submission.payloadFingerprint
    ])
  for (const [index, submission] of submissions.entries()) {
    if (!dispatchWasWithdrawn(submission)) {
      const copy = { index, submittedAt: submission.submittedAt }
      const same = copies.get(scopeKey(submission))
      if (same) {
        same.push(copy)
      } else {
        copies.set(scopeKey(submission), [copy])
      }
    }
  }
  const shown = new Set<string>()
  for (const [index, submission] of submissions.entries()) {
    const { resolvedAt } = submission
    if (
      submission.dispatchState !== 'rejected' ||
      dispatchWasWithdrawn(submission) ||
      submission.queuedMessageId !== undefined ||
      // Persist card ownership on the send so editing/deleting the card cannot resurrect its row.
      submission.keptAsQueuedMessageId !== undefined ||
      commandItemIds.has(agentJournalSubmissionKey(submission.clientMessageId)) ||
      // Collapse rejected retries only when resent after known rejection; earlier intentional repeats remain visible.
      // Both client Retry and host redelivery mint fresh IDs.
      (resolvedAt !== null &&
        (copies.get(scopeKey(submission)) ?? []).some(
          (copy) => copy.index > index && copy.submittedAt >= resolvedAt
        ))
    ) {
      continue
    }
    shown.add(agentJournalSubmissionKey(submission.clientMessageId))
  }
  return shown
}

export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly AgentJournalSubmission[],
  projectItems = projectStructuredItemsToNativeChat
): NativeChatMessage[] {
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
  const inPlace = structuredAgentSessionRejectedShownInPlace(
    submissions,
    structuredAgentSessionCommandItemIds(items),
    items.filter((item) => isAgentSessionContextClear(item.body)).map((item) => item.sequence)
  )
  const visibleItems: AgentJournalRenderItem[] = []
  const unsentItems: AgentJournalRenderItem[] = []
  for (const item of items) {
    if (inPlace.has(item.itemId)) {
      unsentItems.push(item)
    } else if (!rejected.has(item.itemId)) {
      visibleItems.push(item)
    }
  }
  const journalled = new Set(visibleItems.map((item) => item.itemId))
  // Until handover, a queued send has no conversation position, even relative to commands it waits behind.
  const queued = new Set(
    submissions
      .filter(isQueuedAgentJournalSubmission)
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  const delivered: NativeChatMessage[] = []
  const held: NativeChatMessage[] = []
  const shownStopped = new Set<string>()
  let moved = false
  for (const message of projectItems(visibleItems)) {
    if (queued.has(message.id)) {
      held.push({ ...message, queued: true })
    } else if (!placement || !stoppedBeforeStart.has(message.id)) {
      delivered.push(message)
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
  return [
    // Merge unsent rows at journal positions after stop grouping so each run retains one stop notice.
    ...(unsentItems.length > 0
      ? withRowsAtJournalPlaces(
          conversation,
          projectItems(unsentItems).map((message) => ({ ...message, unsent: true as const }))
        )
      : conversation),
    // Held cards follow the conversation outside its runs.
    ...held,
    // Host rows supersede client echoes under either client or provider IDs.
    ...optimistic
      .filter(
        (entry) =>
          !journalled.has(agentJournalSubmissionKey(entry.clientMessageId)) &&
          !submissions.some((submission) => submission.clientMessageId === entry.clientMessageId)
      )
      .map((entry): NativeChatMessage => ({
        id: agentJournalSubmissionKey(entry.clientMessageId),
        role: 'user',
        source: 'transcript',
        timestamp: entry.queuedAt,
        blocks: entry.body.blocks,
        ...(entry.sentWhileStopping ? { sentWhileStopping: true as const } : {})
      }))
  ]
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
