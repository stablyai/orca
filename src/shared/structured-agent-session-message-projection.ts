import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { agentJournalItemPosition } from './agent-session-journal-position'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { collapseProviderRetryRuns } from './native-chat-provider-retry-runs'
import {
  NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION,
  NATIVE_CHAT_STOPPED_BEFORE_START_TEXT
} from './native-chat-stopped-before-start'
import { structuredAgentTurnAnchors } from './native-chat-turn-membership'
import type { NativeChatMessage } from './native-chat-types'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import { structuredAgentSessionEntryHeldForRetry } from './structured-agent-session-outbox-admission'
import { reconcileStructuredAgentSessionOutboxWithQueue } from './structured-agent-session-draft-hand-off'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'

/** One row after each run of sends a Stop took back, placed with the last of them. */
function withStopRowsAfterStoppedSends(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  return messages.flatMap((message, index) =>
    message.stoppedBeforeStart && messages[index + 1]?.stoppedBeforeStart !== true
      ? [
          message,
          {
            id: `stopped-before-start:${message.id}`,
            role: 'system' as const,
            source: 'transcript' as const,
            timestamp: message.timestamp,
            blocks: [
              {
                type: 'text' as const,
                text: NATIVE_CHAT_STOPPED_BEFORE_START_TEXT,
                presentation: NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION
              }
            ],
            stoppedBeforeStart: true as const,
            ...(message.journalPosition ? { journalPosition: message.journalPosition } : {})
          }
        ]
      : [message]
  )
}

export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  projectItems = projectStructuredItemsToNativeChat
): NativeChatMessage[] {
  const optimistic = reconcileStructuredAgentSessionOutboxWithQueue(outbox, submissions)
  // A send a Stop took back before the agent started it stays where it was sent, as the
  // conversation's own history. A queued card's hand-off is left out: the card holds its text.
  const stoppedBeforeStart = new Set(
    submissions
      .filter(
        (submission) => dispatchWasWithdrawn(submission) && submission.queuedMessageId === undefined
      )
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  // Other refused sends are ledger evidence, not conversation history; local drafts remain in the outbox.
  const rejected = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
      .filter((itemId) => !stoppedBeforeStart.has(itemId))
  )
  // A turn opened for it ends saying it was stopped, so such a send stays in that turn.
  const anchored = new Set(structuredAgentTurnAnchors(items, submissions).values())
  const visibleItems: AgentJournalRenderItem[] = []
  const refused = new Map<string, AgentJournalRenderItem>()
  for (const item of items) {
    if (rejected.has(item.itemId)) {
      refused.set(item.itemId, item)
    } else {
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
  for (const message of projectItems(visibleItems)) {
    if (queued.has(message.id)) {
      held.push({ ...message, queued: true })
    } else if (stoppedBeforeStart.has(message.id) && !anchored.has(message.id)) {
      delivered.push({ ...message, stoppedBeforeStart: true })
    } else {
      delivered.push(message)
    }
  }
  return [
    // After the held sends leave: they are drawn after the conversation, never inside a run.
    ...withStopRowsAfterStoppedSends(collapseProviderRetryRuns(delivered)),
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
            : entry.sentWhileStopping
              ? { sentWhileStopping: true as const }
              : {}),
          // A send the journal recorded before refusing it keeps its place there.
          ...(recorded ? { journalPosition: agentJournalItemPosition(recorded) } : {})
        }
      })
  ]
}
