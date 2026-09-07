import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

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
      Array.from({ length: sendCount }, (_, index) => submission(sendCount - index - 1))
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

    const messages = projectStructuredAgentSessionMessages([walItem], outbox, [pending])
    const optimistic = projectStructuredAgentSessionMessages([], outbox, [])

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

    expect(projectStructuredAgentSessionMessages([], outbox, [])).toMatchObject([
      { id: agentJournalSubmissionKey('client-pending'), role: 'user' }
    ])
  })
})
