import { expect, it } from 'vitest'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../../shared/agent-session/structured-agent-session-reducer'
import type { AgentJournalSubmission } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionReadSnapshot } from '../session/structured/read/structured-agent-session-read-owner-contract'
import { readNativeChatStructuredSubmissionDelivery } from './native-chat-structured-submission-delivery'

function deliveryFixture() {
  let snapshot: StructuredAgentSessionReadSnapshot = {
    state: { ...EMPTY_STRUCTURED_AGENT_SESSION, epoch: 'conversation' },
    loadingOlder: false,
    olderHistoryGeneration: 0,
    initialHistoryAutoLoad: true,
    current: true
  }
  const listeners = new Set<() => void>()
  const owner = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  const publish = (state: Partial<StructuredAgentSessionReadSnapshot['state']>) => {
    snapshot = { ...snapshot, state: { ...snapshot.state, ...state } }
    listeners.forEach((listener) => listener())
  }
  return { owner, publish }
}

function submission(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState']
): AgentJournalSubmission {
  return {
    clientMessageId,
    queuedMessageId: 'queued-send',
    fence: 1,
    payloadFingerprint: 'payload',
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}

it('observes acceptance after a rejected queued handoff is retried', async () => {
  const { owner, publish } = deliveryFixture()
  const delivery = readNativeChatStructuredSubmissionDelivery(
    owner,
    'queued-send',
    new AbortController().signal
  )
  const rejected = submission('first-attempt', 'rejected')
  publish({
    submissions: [rejected],
    queuedMessages: [
      {
        messageId: 'queued-send',
        position: 1,
        body: { kind: 'message', role: 'user', blocks: [] },
        state: 'waiting'
      }
    ]
  })
  publish({ submissions: [rejected, submission('retry', 'pending')], queuedMessages: [] })
  publish({ activity: null })
  publish({ submissions: [rejected, submission('retry', 'accepted')] })
  expect(await delivery).toBe(true)
})
