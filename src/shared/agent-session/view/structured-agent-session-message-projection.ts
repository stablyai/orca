import {
  commandItemIdSteps,
  rejectedShownInPlaceSteps
} from './structured-agent-session-rejected-presentation'
export {
  structuredAgentSessionCommandItemIds,
  structuredAgentSessionRejectedShownInPlace
} from './structured-agent-session-rejected-presentation'
import {
  finishAgentSessionSteps,
  indexAgentSessionSteps,
  setAgentSessionSteps,
  mapAgentSessionSteps,
  filterAgentSessionSteps,
  sortAgentSessionSteps,
  flatMapAgentSessionSteps
} from '../agent-session-projection-steps'
import type { AgentJournalCursor } from '../journal/agent-session-journal-identity'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING } from '../requests/structured-agent-session-send-evidence'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { selectAgentSessionCurrentRequests } from '../requests/agent-session-current-requests'
import { isQueuedAgentJournalSubmission } from '../requests/agent-session-queued-submission'
import { collapseProviderRetryRunSteps } from '../../native-chat/native-chat-provider-retry-runs'
import {
  keepStoppedSendsInSendOrderSteps,
  placeStoppedSendSteps,
  withStopRowsAfterStoppedSendSteps
} from '../../native-chat/native-chat-stopped-before-start'
import { compareNativeChatTranscriptMessages } from '../../native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../native-chat/native-chat-types'
import { dispatchWasWithdrawn } from '../requests/structured-agent-session-dispatch-rejection'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'
import { isActionableStructuredAgentSessionPrompt } from './structured-agent-session-live-turn'
import { isAgentSessionContextClear } from '../agent-session-context-clear'

/** Client echo until host publication; an acknowledged read past recordedCursor supersedes it. */
export type StructuredAgentSessionOptimisticMessage = {
  clientMessageId: string
  body: AgentJournalMessageItem
  queuedAt: number
  phase?: 'sending' | 'recorded' | 'unconfirmed'
  recordedCursor?: AgentJournalCursor
  /** In-memory placement captured at Send, independent of any acknowledgement. */
  afterSequence?: number
  options?: Readonly<Record<string, string>>
  /** Sent while the chat read Stopping: drawn after the turn being stopped. */
  sentWhileStopping?: true
}

export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly AgentJournalSubmission[],
  projectItems = projectStructuredItemsToNativeChat
): NativeChatMessage[] {
  return finishAgentSessionSteps(
    projectStructuredAgentSessionMessageSteps(items, optimistic, submissions, projectItems)
  )
}
export function* projectStructuredAgentSessionMessageSteps(
  items: readonly AgentJournalRenderItem[],
  optimistic: readonly StructuredAgentSessionOptimisticMessage[],
  submissions: readonly AgentJournalSubmission[],
  projectItems = projectStructuredItemsToNativeChat,
  projectItemSteps?: (
    items: readonly AgentJournalRenderItem[]
  ) => Generator<void, NativeChatMessage[]>
): Generator<void, NativeChatMessage[]> {
  // Keep stopped-before-start sends in conversation history; queued handoffs stay in their cards.
  const stoppedBeforeStart = new Map<string, AgentJournalSubmission>()
  const rejected = new Set<string>()
  const clearSequences: number[] = []
  for (const submission of submissions) {
    const id = agentJournalSubmissionKey(submission.clientMessageId)
    if (dispatchWasWithdrawn(submission) && submission.queuedMessageId === undefined) {
      stoppedBeforeStart.set(id, submission)
    } else if (submission.dispatchState === 'rejected') {
      rejected.add(id)
    }
    yield
  }
  for (const item of items) {
    if (isAgentSessionContextClear(item.body)) {
      clearSequences.push(item.sequence)
    }
    yield
  }
  const placement =
    stoppedBeforeStart.size > 0
      ? yield* placeStoppedSendSteps(items, submissions, stoppedBeforeStart)
      : null
  const inPlace = yield* rejectedShownInPlaceSteps(
    submissions,
    yield* commandItemIdSteps(items),
    clearSequences
  )
  const visibleItems: AgentJournalRenderItem[] = []
  const unsentItems: AgentJournalRenderItem[] = []
  for (const item of items) {
    yield
    if (inPlace.has(item.itemId)) {
      unsentItems.push(item)
    } else if (!rejected.has(item.itemId)) {
      visibleItems.push(item)
    }
  }
  const journalled = yield* setAgentSessionSteps(
    yield* mapAgentSessionSteps(visibleItems, (item) => item.itemId)
  )
  const submissionsByItemId = yield* indexAgentSessionSteps(
    yield* mapAgentSessionSteps(
      submissions,
      (submission) => [agentJournalSubmissionKey(submission.clientMessageId), submission] as const
    )
  )
  const project = function* (
    selected: readonly AgentJournalRenderItem[]
  ): Generator<void, NativeChatMessage[]> {
    return projectItemSteps
      ? yield* projectItemSteps(selected)
      : projectItems === projectStructuredItemsToNativeChat
        ? yield* flatMapAgentSessionSteps(selected, (item) => projectItems([item]))
        : projectItems(selected)
  }
  const delivered: NativeChatMessage[] = []
  const held: NativeChatMessage[] = []
  const shownStopped = new Set<string>()
  let moved = false
  for (const row of yield* project(visibleItems)) {
    yield
    const submission = submissionsByItemId.get(row.id)
    const message: NativeChatMessage =
      submission?.dispatchState === 'pending' || submission?.dispatchState === 'unknown'
        ? {
            ...row,
            deliveryState: submission.dispatchState,
            ...(submission.queuedMessageId ? { queuedMessageId: submission.queuedMessageId } : {})
          }
        : row
    // Until handover, queued sends have no conversation position.
    if (submission && isQueuedAgentJournalSubmission(submission)) {
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
    moved =
      (yield* keepStoppedSendsInSendOrderSteps(delivered, stoppedBeforeStart, shownStopped)) ||
      moved
  }
  const collapsed = yield* collapseProviderRetryRunSteps(delivered)
  const ordered = moved
    ? yield* sortAgentSessionSteps(collapsed, compareNativeChatTranscriptMessages)
    : collapsed
  const conversation =
    shownStopped.size > 0
      ? yield* withStopRowsAfterStoppedSendSteps(ordered, shownStopped)
      : ordered
  const unsent =
    unsentItems.length > 0
      ? yield* withRowsAtJournalPlaceSteps(
          conversation,
          yield* mapAgentSessionSteps(yield* project(unsentItems), (message) => ({
            ...message,
            unsent: true as const
          }))
        )
      : conversation
  const echoes = yield* mapAgentSessionSteps(
    yield* filterAgentSessionSteps(optimistic, (entry) => {
      const key = agentJournalSubmissionKey(entry.clientMessageId)
      const submission = submissionsByItemId.get(key)
      return (
        !journalled.has(key) &&
        (!submission ||
          submission.dispatchState === 'pending' ||
          submission.reason === STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING)
      )
    }),
    (entry): NativeChatMessage => {
      const id = agentJournalSubmissionKey(entry.clientMessageId)
      const submission = submissionsByItemId.get(id)
      const hostPending =
        submission?.dispatchState === 'pending' &&
        submission.reason !== STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING
      return {
        id,
        role: 'user',
        source: 'transcript',
        deliveryState:
          hostPending || entry.phase === 'recorded' || entry.recordedCursor !== undefined
            ? 'pending'
            : 'unknown',
        timestamp: entry.queuedAt,
        blocks: entry.body.blocks,
        ...(entry.afterSequence !== undefined
          ? { journalPosition: { sequence: entry.afterSequence + 0.5, index: entry.queuedAt } }
          : {}),
        ...(entry.sentWhileStopping ? { sentWhileStopping: true as const } : {})
      }
    }
  )
  const result: NativeChatMessage[] = []
  for (const rows of [unsent, held, echoes]) {
    for (const row of rows) {
      result.push(row)
      yield
    }
  }
  return result
}

/** Merge placed rows in journal order so clients rendering the list directly need no sort. */
function* withRowsAtJournalPlaceSteps(
  rows: readonly NativeChatMessage[],
  placed: NativeChatMessage[]
): Generator<void, NativeChatMessage[]> {
  placed = yield* sortAgentSessionSteps(placed, compareNativeChatTranscriptMessages)
  const merged: NativeChatMessage[] = []
  let next = 0
  for (const row of rows) {
    yield
    while (next < placed.length && compareNativeChatTranscriptMessages(placed[next], row) < 0) {
      merged.push(placed[next++])
      yield
    }
    merged.push(row)
  }
  while (next < placed.length) {
    merged.push(placed[next++])
    yield
  }
  return merged
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
