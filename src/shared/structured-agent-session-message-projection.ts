import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { collapseProviderRetryRuns } from './native-chat-provider-retry-runs'
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

/** A message this client sent that the host has not drawn yet: its bubble until the row lands. */
export type StructuredAgentSessionOptimisticMessage = {
  clientMessageId: string
  body: AgentJournalMessageItem
  queuedAt: number
  /** Sent while the chat read Stopping: drawn after the turn being stopped. */
  sentWhileStopping?: true
}

export type StructuredAgentSessionMessageProjectionOptions = {
  /** Draw a message the host accepted and then rejected where the host recorded it, as not sent.
   *  Off for a client that hands such a message back to its composer instead. */
  rejectedInPlace: boolean
}

/** The loaded items that are a conversation command such as `/compact`, by item id. */
export function structuredAgentSessionCommandItemIds(
  items: readonly AgentJournalRenderItem[]
): Set<string> {
  return new Set(
    items
      .filter((item) => item.body.kind === 'message' && item.body.command)
      .map((item) => item.itemId)
  )
}

/**
 * The rejected submissions the host's history shows in place as not sent, by item id; `submissions`
 * in submission order, as the client keeps them. A withdrawn one is drawn as a stopped send, one the
 * queue holds (a draft's hand-off, or a send kept as a card) is drawn as its card, and a command
 * such as `/compact` has its rejection reported as its own reply.
 */
export function structuredAgentSessionRejectedShownInPlace(
  submissions: readonly AgentJournalSubmission[],
  commandItemIds: ReadonlySet<string>,
  clearSequences: readonly number[] = []
): Set<string> {
  // Each body's copies, as positions in submission order. A withdrawn one is no failed copy, so it
  // supersedes nothing.
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
      // Recorded on the send itself, so an Edit or Delete of its card brings no row back.
      submission.keptAsQueuedMessageId !== undefined ||
      commandItemIds.has(agentJournalSubmissionKey(submission.clientMessageId)) ||
      // Collapses resends of a rejected message: past Retries resent it under a new id, and the
      // host re-delivers its own messages under new ids. Only a later copy sent once the rejection
      // was known counts, so a repeat sent before it is kept.
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
  options: StructuredAgentSessionMessageProjectionOptions,
  projectItems = projectStructuredItemsToNativeChat
): NativeChatMessage[] {
  // A send a Stop took back before the agent started it stays where it was sent, as the
  // conversation's own history. A queued card's hand-off is left out: the card holds its text.
  const stoppedBeforeStart = new Map(
    submissions
      .filter(
        (submission) => dispatchWasWithdrawn(submission) && submission.queuedMessageId === undefined
      )
      .map((submission) => [agentJournalSubmissionKey(submission.clientMessageId), submission])
  )
  // Other refused sends are ledger evidence, not conversation history, unless drawn in place as
  // not sent.
  const rejected = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
      .filter((itemId) => !stoppedBeforeStart.has(itemId))
  )
  // Runs on every streaming commit, so a chat with no such send pays nothing for placing one.
  const placement =
    stoppedBeforeStart.size > 0 ? placeStoppedSends(items, submissions, stoppedBeforeStart) : null
  const inPlace = options.rejectedInPlace
    ? structuredAgentSessionRejectedShownInPlace(
        submissions,
        structuredAgentSessionCommandItemIds(items),
        items.filter((item) => isAgentSessionContextClear(item.body)).map((item) => item.sequence)
      )
    : new Set<string>()
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
  // Not delivered yet, so nothing the agent does meanwhile — a command it waits behind — comes
  // after it. Its handover places it in the conversation.
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
      // A turn opened for it: that turn's interrupted end is its stop, so it gets no row of its own.
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
  const conversation = moved
    ? Array.from(collapseProviderRetryRuns(delivered)).sort(compareNativeChatTranscriptMessages)
    : collapseProviderRetryRuns(delivered)
  return [
    // After the held sends leave: they are drawn after the conversation, never inside a run.
    ...(shownStopped.size > 0
      ? withStopRowsAfterStoppedSends(conversation, shownStopped)
      : conversation),
    ...held,
    // In no turn; the journal position keeps their place.
    ...projectItems(unsentItems).map((message) => ({ ...message, unsent: true as const })),
    // The host's row draws a message once it has one, under its own id or the provider's.
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
