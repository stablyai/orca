import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const NO_CARDS: readonly string[] = []

function submission(index: number): AgentJournalSubmission {
  return {
    clientMessageId: `client-${index}`,
    fence: 1,
    payloadFingerprint: `fingerprint-${index}`,
    dispatchState: 'accepted',
    providerItemId: `provider-${index}`,
    reason: null,
    submittedAt: index,
    resolvedAt: index
  }
}

function item(index: number): AgentJournalRenderItem {
  return {
    itemId: `journal-${index}`,
    revision: 1,
    sequence: index,
    observedAt: index,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `send ${index}` }] }
  }
}

describe('structured agent session message projection', () => {
  it('marks a message waiting for its next start, and only that one, as waiting to start', () => {
    const queued = (index: number, startRetry?: AgentJournalSubmission['startRetry']) => ({
      ...submission(index),
      dispatchState: 'pending' as const,
      providerItemId: null,
      resolvedAt: null,
      handoverRecorded: true as const,
      ...(startRetry ? { startRetry } : {})
    })
    const waiting = queued(0, {
      attempts: 1,
      reason: 'A Claude account switch is in progress.',
      rejection: { kind: 'accountSwitchInProgress' },
      failedAt: 1,
      nextAttemptAt: 15_001
    })
    const items = [0, 1].map((index) => ({
      ...item(index),
      itemId: agentJournalSubmissionKey(`client-${index}`)
    }))
    expect(
      projectStructuredAgentSessionMessages(items, [], [waiting, queued(1)], NO_CARDS)
    ).toEqual([
      expect.objectContaining({ id: items[0]!.itemId, queued: true, waitingToStart: true }),
      expect.not.objectContaining({ waitingToStart: true })
    ])
  })

  // The host recorded it, so its row is the message from here; the outbox copy gives way.
  it("draws a send the host rejected from the host's row, not the outbox copy", () => {
    const rejected = { ...submission(0), dispatchState: 'rejected' as const, providerItemId: null }
    const refusedItem = { ...item(0), itemId: agentJournalSubmissionKey(rejected.clientMessageId) }
    const draft = createStructuredAgentSessionOutboxEntry({
      clientMessageId: rejected.clientMessageId,
      sessionId: 'session-1',
      text: 'An unsent draft',
      attachments: [],
      queuedAt: 1
    })
    expect(
      projectStructuredAgentSessionMessages([refusedItem], [draft], [rejected], NO_CARDS)
    ).toEqual([
      expect.objectContaining({
        id: refusedItem.itemId,
        blocks: [{ type: 'text', text: 'send 0' }],
        unsent: true
      })
    ])
  })

  it.each([5, 10])('renders %i rapid accepted desktop sends exactly once', (sendCount) => {
    const outbox = Array.from({ length: sendCount }, (_, index) =>
      createStructuredAgentSessionOutboxEntry({
        clientMessageId: `client-${index}`,
        sessionId: 'session-1',
        text: `send ${index}`,
        attachments: [],
        queuedAt: index
      })
    )
    const messages = projectStructuredAgentSessionMessages(
      Array.from({ length: sendCount }, (_, index) => item(index)),
      outbox,
      Array.from({ length: sendCount }, (_, index) => submission(sendCount - index - 1)),
      NO_CARDS
    )

    expect(messages.filter((message) => message.role === 'user')).toHaveLength(sendCount)
    expect(messages.map((message) => message.id)).toEqual(
      Array.from({ length: sendCount }, (_, index) => `journal-${index}`)
    )
  })

  it('renders one bubble while the submission is still dispatching', () => {
    const outbox = [
      createStructuredAgentSessionOutboxEntry({
        clientMessageId: 'client-pending',
        sessionId: 'session-1',
        text: 'Ok thanks',
        attachments: [],
        queuedAt: 1
      })
    ]
    // The host's WAL row is on screen while the provider round trip is in flight.
    const walItem: AgentJournalRenderItem = {
      itemId: agentJournalSubmissionKey('client-pending'),
      revision: 0,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Ok thanks' }] }
    }
    const pending: AgentJournalSubmission = {
      ...submission(0),
      clientMessageId: 'client-pending',
      dispatchState: 'pending',
      providerItemId: null,
      resolvedAt: null
    }

    const messages = projectStructuredAgentSessionMessages([walItem], outbox, [pending], NO_CARDS)
    const optimistic = projectStructuredAgentSessionMessages([], outbox, [], NO_CARDS)

    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(messages.map((message) => message.id)).toEqual([walItem.itemId])
    expect(optimistic[0]?.id).toBe(messages[0]?.id)
  })

  it('keeps an optimistic send until its acceptance arrives', () => {
    const outbox = [
      createStructuredAgentSessionOutboxEntry({
        clientMessageId: 'client-pending',
        sessionId: 'session-1',
        text: 'pending',
        attachments: [],
        queuedAt: 1
      })
    ]

    expect(projectStructuredAgentSessionMessages([], outbox, [], NO_CARDS)).toMatchObject([
      { id: agentJournalSubmissionKey('client-pending'), role: 'user' }
    ])
  })
})
