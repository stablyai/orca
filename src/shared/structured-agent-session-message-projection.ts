import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { agentJournalItemPosition } from './agent-session-journal-position'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import { collapseProviderRetryRuns } from './native-chat-provider-retry-runs'
import type { NativeChatMessage } from './native-chat-types'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'
import { structuredAgentSessionEntryHeldForRetry } from './structured-agent-session-outbox-admission'
import { reconcileStructuredAgentSessionOutboxWithQueue } from './structured-agent-session-draft-hand-off'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import { isStructuredAgentSessionCommandEntry } from './structured-agent-session-command-entry'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'

export function projectStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  projectItems = projectStructuredItemsToNativeChat
): NativeChatMessage[] {
  const optimistic = reconcileStructuredAgentSessionOutboxWithQueue(outbox, submissions)
  // A send the host recorded and then did not deliver stays in the conversation from the host's
  // record, shown as not sent, for every viewer: dropping the sender's outbox entry can never make
  // it vanish. It leaves only where something else owns it: the user withdrew it with Stop, its
  // queued draft's card keeps the text, or it is a command whose reply or result row says it failed.
  const notSent = new Set<string>()
  const ownedElsewhere = new Set<string>()
  for (const submission of submissions) {
    if (submission.dispatchState !== 'rejected') {
      continue
    }
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    if (dispatchWasWithdrawn(submission) || submission.queuedMessageId !== undefined) {
      ownedElsewhere.add(key)
    } else {
      notSent.add(key)
    }
  }
  const visibleItems: AgentJournalRenderItem[] = []
  const refused = new Map<string, AgentJournalRenderItem>()
  for (const item of items) {
    if (
      ownedElsewhere.has(item.itemId) ||
      (notSent.has(item.itemId) && isStructuredAgentSessionCommandEntry(item.body))
    ) {
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
    if (notSent.has(message.id)) {
      delivered.push({ ...message, unsent: true })
    } else if (queued.has(message.id)) {
      held.push({ ...message, queued: true })
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
