import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { isRetryingStructuredAgentSessionStart } from './structured-agent-session-start-retry'
import { collapseProviderRetryRuns } from './native-chat-provider-retry-runs'
import type { NativeChatMessage } from './native-chat-types'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import { structuredAgentSessionEntryHeldForRetry } from './structured-agent-session-outbox-admission'
import { reconcileStructuredAgentSessionOutboxWithQueue } from './structured-agent-session-draft-hand-off'
import { failedStartsSentElsewhere } from './structured-agent-session-failed-start-elsewhere'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'

export type StructuredAgentSessionMessageProjectionOptions = {
  /** Draw a message the host accepted and then rejected where the host recorded it, as not sent.
   *  Off for a client that hands such a message back to its composer instead. */
  rejectedInPlace: boolean
  /** The queue's live cards: a rejected message one of them holds is drawn there, not here. */
  queuedMessageIds?: readonly string[]
  /** With `rejectedInPlace` off, still draw a failed start sent from elsewhere as not sent, for a
   *  host that can queue it again: no composer here holds it. */
  showsFailedStartsSentElsewhere?: boolean
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
 * in submission order, as the client keeps them. A withdrawn one went back to its sender, one the
 * queue holds (a draft's hand-off, or a card under its id) is drawn as its card, and a command such
 * as `/compact` has its rejection reported as its own reply.
 */
export function structuredAgentSessionRejectedShownInPlace(
  submissions: readonly AgentJournalSubmission[],
  queuedMessageIds: readonly string[],
  commandItemIds: ReadonlySet<string>
): Set<string> {
  const cards = new Set(queuedMessageIds)
  // Each body's copies, as positions in submission order. A withdrawn one is hidden too, so it
  // supersedes nothing.
  const copies = new Map<string, { index: number; submittedAt: number }[]>()
  for (const [index, submission] of submissions.entries()) {
    if (!dispatchWasWithdrawn(submission)) {
      const copy = { index, submittedAt: submission.submittedAt }
      const same = copies.get(submission.payloadFingerprint)
      if (same) {
        same.push(copy)
      } else {
        copies.set(submission.payloadFingerprint, [copy])
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
      cards.has(submission.clientMessageId) ||
      commandItemIds.has(agentJournalSubmissionKey(submission.clientMessageId)) ||
      // Collapses resends of a rejected message: past Retries resent it under a new id, and the
      // host re-delivers its own messages under new ids. Only a later copy sent once the rejection
      // was known counts, so a repeat sent before it is kept.
      (resolvedAt !== null &&
        (copies.get(submission.payloadFingerprint) ?? []).some(
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
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  options: StructuredAgentSessionMessageProjectionOptions,
  projectItems = projectStructuredItemsToNativeChat
): NativeChatMessage[] {
  const optimistic = reconcileStructuredAgentSessionOutboxWithQueue(outbox, submissions, items)
  // Refused sends are ledger evidence, not conversation history, unless drawn in place as not sent.
  const rejected = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  const inPlace = options.rejectedInPlace
    ? structuredAgentSessionRejectedShownInPlace(
        submissions,
        options.queuedMessageIds ?? [],
        structuredAgentSessionCommandItemIds(items)
      )
    : new Set<string>()
  // Sent from elsewhere and refused for good by a failed start: shown as unsent where the journal
  // recorded it, by a client that draws no other rejection in place.
  const unsentElsewhere = new Set(
    !options.rejectedInPlace && options.showsFailedStartsSentElsewhere
      ? failedStartsSentElsewhere(submissions, outbox).map((submission) =>
          agentJournalSubmissionKey(submission.clientMessageId)
        )
      : []
  )
  const visibleItems: AgentJournalRenderItem[] = []
  const unsentItems: AgentJournalRenderItem[] = []
  for (const item of items) {
    if (inPlace.has(item.itemId)) {
      unsentItems.push(item)
    } else if (!rejected.has(item.itemId) || unsentElsewhere.has(item.itemId)) {
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
  const waiting = new Set(
    submissions
      .filter(isRetryingStructuredAgentSessionStart)
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  const delivered: NativeChatMessage[] = []
  const held: NativeChatMessage[] = []
  for (const message of projectItems(visibleItems)) {
    if (queued.has(message.id)) {
      held.push({
        ...message,
        queued: true,
        ...(waiting.has(message.id) ? { waitingToStart: true as const } : {})
      })
    } else if (unsentElsewhere.has(message.id)) {
      delivered.push({ ...message, unsent: true })
    } else {
      delivered.push(message)
    }
  }
  return [
    // After the held sends leave: they are drawn after the conversation, never inside a run.
    ...collapseProviderRetryRuns(delivered),
    ...held,
    // In no turn, like the outbox's not-sent rows; the journal position keeps their place.
    ...projectItems(unsentItems).map((message) => ({ ...message, unsent: true as const })),
    ...optimistic
      .filter((entry) => !journalled.has(agentJournalSubmissionKey(entry.clientMessageId)))
      .map((entry): NativeChatMessage => ({
        id: agentJournalSubmissionKey(entry.clientMessageId),
        role: 'user',
        source: 'transcript',
        timestamp: entry.queuedAt,
        blocks: entry.body.blocks,
        ...(entry.state === 'rejected' || structuredAgentSessionEntryHeldForRetry(entry)
          ? { unsent: true as const }
          : {})
      }))
  ]
}
