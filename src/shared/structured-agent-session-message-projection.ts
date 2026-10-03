import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { agentJournalItemPosition } from './agent-session-journal-position'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { isRetryingStructuredAgentSessionStart } from './structured-agent-session-start-retry'
import { collapseProviderRetryRuns } from './native-chat-provider-retry-runs'
import type { NativeChatMessage } from './native-chat-types'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import { structuredAgentSessionEntryHeldForRetry } from './structured-agent-session-outbox-admission'
import { reconcileStructuredAgentSessionOutboxWithQueue } from './structured-agent-session-draft-hand-off'
import {
  failedStartsSentElsewhere,
  undeliveredSentElsewhere
} from './structured-agent-session-failed-start-elsewhere'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'

export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  {
    projectItems = projectStructuredItemsToNativeChat,
    showsFailedStartsSentElsewhere = true,
    showsUndeliveredSentElsewhere = true,
    sentHere = outbox
  }: {
    projectItems?: typeof projectStructuredItemsToNativeChat
    /** Whether the host can queue one again: an older host's are left hidden, as before. */
    showsFailedStartsSentElsewhere?: boolean
    /** Whether the surface marks a message as unsent; one that can't leaves these hidden. */
    showsUndeliveredSentElsewhere?: boolean
    /** This client's whole outbox, cards' sends included, where `outbox` is only what the
     *  transcript draws: no row of a message it holds is drawn as sent elsewhere. */
    sentHere?: readonly Pick<StructuredAgentSessionOutboxEntry, 'clientMessageId' | 'rotatedFrom'>[]
  } = {}
): NativeChatMessage[] {
  const optimistic = reconcileStructuredAgentSessionOutboxWithQueue(outbox, submissions)
  // Refused sends are ledger evidence, not conversation history; local drafts remain in the outbox.
  const rejected = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  // Sent from elsewhere and refused for good by a failed start, or rejected after it was handed
  // over: shown as unsent, as this client's own would be, where the journal put it.
  const unsentElsewhere = new Set(
    [
      ...(showsFailedStartsSentElsewhere ? failedStartsSentElsewhere(submissions, sentHere) : []),
      ...(showsUndeliveredSentElsewhere ? undeliveredSentElsewhere(submissions, sentHere) : [])
    ].map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  const visibleItems: AgentJournalRenderItem[] = []
  const refused = new Map<string, AgentJournalRenderItem>()
  for (const item of items) {
    if (rejected.has(item.itemId)) {
      refused.set(item.itemId, item)
    }
    if (!rejected.has(item.itemId) || unsentElsewhere.has(item.itemId)) {
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
      const recorded = refused.get(message.id)
      delivered.push({
        ...message,
        unsent: true,
        ...(recorded ? { journalPosition: agentJournalItemPosition(recorded) } : {})
      })
    } else {
      delivered.push(message)
    }
  }
  return [
    // After the held sends leave: they are drawn after the conversation, never inside a run.
    ...collapseProviderRetryRuns(delivered),
    ...held,
    ...optimistic
      .filter((entry) => !journalled.has(agentJournalSubmissionKey(entry.clientMessageId)))
      .map((entry): NativeChatMessage => {
        const id = agentJournalSubmissionKey(entry.clientMessageId)
        const recorded = refused.get(id)
        return {
          id,
          role: 'user',
          source: 'transcript',
          timestamp: entry.queuedAt,
          blocks: entry.body.blocks,
          ...(entry.state === 'rejected' || structuredAgentSessionEntryHeldForRetry(entry)
            ? { unsent: true as const }
            : {}),
          // A send the journal recorded before refusing it keeps its place there.
          ...(recorded ? { journalPosition: agentJournalItemPosition(recorded) } : {})
        }
      })
  ]
}
