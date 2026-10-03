import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../../../shared/agent-session-turn-record'
import { projectStructuredAgentSessionMessages as projectForPhone } from '../../../../shared/structured-agent-session-message-projection'
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
  it('shows a recorded send the host did not deliver as not sent, never as sent', () => {
    const rejected = { ...submission(0), dispatchState: 'rejected' as const, providerItemId: null }
    const refusedItem = { ...item(0), itemId: agentJournalSubmissionKey(rejected.clientMessageId) }
    const acceptedItem = item(1)
    expect(
      projectStructuredAgentSessionMessages([refusedItem, acceptedItem], [], [rejected])
    ).toMatchObject([
      { id: refusedItem.itemId, role: 'user', unsent: true },
      { id: acceptedItem.itemId, role: 'user' }
    ])
  })

  it('keeps a recorded send in the chat after its outbox entry is gone and the host settles it undelivered', () => {
    // Orca restarted mid-send: the entry left this client, then the next agent start proved the
    // provider never took the message.
    const notDelivered = {
      ...submission(0),
      dispatchState: 'rejected' as const,
      providerItemId: null,
      reason: 'not_delivered'
    }
    const recordedItem = {
      ...item(0),
      itemId: agentJournalSubmissionKey(notDelivered.clientMessageId)
    }
    const messages = projectStructuredAgentSessionMessages([recordedItem], [], [notDelivered])
    expect(messages).toMatchObject([
      {
        id: recordedItem.itemId,
        unsent: true,
        blocks: [{ type: 'text', text: 'send 0' }],
        journalPosition: { sequence: 0 }
      }
    ])
  })

  it('leaves out a send the user withdrew with Stop', () => {
    const withdrawn = {
      ...submission(0),
      dispatchState: 'rejected' as const,
      providerItemId: null,
      reason: 'provider_cancelled_before_start'
    }
    const withdrawnItem = {
      ...item(0),
      itemId: agentJournalSubmissionKey(withdrawn.clientMessageId)
    }
    expect(projectStructuredAgentSessionMessages([withdrawnItem], [], [withdrawn])).toEqual([])
  })

  it("shows the sender's recorded rejection once, from the journal, while its outbox entry holds the Retry", () => {
    const rejected = { ...submission(0), dispatchState: 'rejected' as const, providerItemId: null }
    const refusedItem = { ...item(0), itemId: agentJournalSubmissionKey(rejected.clientMessageId) }
    const draft = {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: rejected.clientMessageId,
        sessionId: 'session-1',
        text: 'send 0',
        attachments: [],
        queuedAt: 1
      }),
      state: 'rejected' as const
    }
    expect(projectStructuredAgentSessionMessages([refusedItem], [draft], [rejected])).toEqual([
      expect.objectContaining({ id: refusedItem.itemId, unsent: true })
    ])
  })

  it("keeps the not-sent original when the sender's Retry sends it again as a new message", () => {
    const rejected = { ...submission(0), dispatchState: 'rejected' as const, providerItemId: null }
    const refusedItem = { ...item(0), itemId: agentJournalSubmissionKey(rejected.clientMessageId) }
    const resend = createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'rotated-id',
      sessionId: 'session-1',
      text: 'send 0',
      attachments: [],
      queuedAt: 2
    })
    expect(projectStructuredAgentSessionMessages([refusedItem], [resend], [rejected])).toEqual([
      expect.objectContaining({ id: refusedItem.itemId, unsent: true }),
      expect.objectContaining({ id: agentJournalSubmissionKey('rotated-id') })
    ])
  })

  // The command's reply (blocked) or its turn's result row (refused) already says it failed.
  const busy = { text: 'thread busy', audience: 'person' as const }
  it.each<{
    name: string
    rejection: AgentSessionFailureFact
    resultRow?: AgentSessionFailureFact
  }>([
    { name: 'blocked at handover', rejection: { kind: 'commandRefused' } },
    {
      name: 'refused by the provider',
      rejection: { kind: 'providerRejected', detail: busy },
      resultRow: { kind: 'compactionFailed', detail: busy }
    }
  ])(
    'says a /compact $name failed only where the command reports it',
    ({ rejection, resultRow }) => {
      const opensTurn = resultRow !== undefined
      const compact = {
        ...submission(0),
        dispatchState: 'rejected' as const,
        providerItemId: null,
        rejection
      }
      const userItemId = agentJournalSubmissionKey(compact.clientMessageId)
      const commandItem: AgentJournalRenderItem = {
        itemId: userItemId,
        revision: 1,
        sequence: 0,
        observedAt: 0,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: '/compact' }],
          command: { name: 'compact' }
        }
      }
      const turnItemId = agentJournalItemKey({
        provider: 'orca',
        clientMessageId: 'command-turn:c'
      })
      const resultId = agentJournalItemKey({
        provider: 'orca',
        clientMessageId: 'command-result:c'
      })
      const turnRows: AgentJournalRenderItem[] = resultRow
        ? [
            {
              itemId: turnItemId,
              revision: 1,
              sequence: 1,
              observedAt: 1,
              body: agentJournalTurnBody({
                turnId: 'compact:c',
                state: 'completed',
                outcome: 'failure',
                userItemId,
                requestedAt: 0,
                startedAt: 1,
                completedAt: 2
              })
            },
            {
              itemId: resultId,
              revision: 1,
              sequence: 2,
              observedAt: 2,
              turnScope: { kind: 'turn', turnItemId },
              body: {
                kind: 'status',
                tone: 'error',
                ...agentSessionFailureWords(resultRow, { agentName: 'Codex', surface: 'row' })
              }
            }
          ]
        : []
      const items = [commandItem, ...turnRows]
      for (const messages of [
        projectStructuredAgentSessionMessages(items, [], [compact]),
        projectForPhone(items, [], [compact])
      ]) {
        expect(messages.find((message) => message.id === userItemId)).toBeUndefined()
        expect(messages.some((message) => message.unsent === true)).toBe(false)
        expect(messages.some((message) => message.id === resultId)).toBe(opensTurn)
      }
    }
  )

  // The host sends a queued draft under a fresh id per hand-off; its card keeps the text meanwhile.
  it('leaves a rejected queued-draft hand-off to its card: one bubble once a later hand-off lands', () => {
    const handOff = (index: number, dispatchState: 'rejected' | 'accepted') => ({
      ...submission(index),
      clientMessageId: `handoff-${index}`,
      queuedMessageId: 'draft-1',
      dispatchState,
      ...(dispatchState === 'rejected'
        ? {
            providerItemId: null,
            reason: 'host_restarted',
            rejection: { kind: 'hostRestarted' as const }
          }
        : {})
    })
    const handOffRow = (index: number): AgentJournalRenderItem => ({
      ...item(index),
      itemId: agentJournalSubmissionKey(`handoff-${index}`),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'same draft text' }] }
    })
    const items = [handOffRow(1), handOffRow(2)]
    const submissions = [handOff(1, 'rejected'), handOff(2, 'accepted')]
    for (const messages of [
      projectStructuredAgentSessionMessages(items, [], submissions),
      projectForPhone(items, [], submissions)
    ]) {
      expect(messages).toEqual([
        expect.objectContaining({ id: agentJournalSubmissionKey('handoff-2') })
      ])
      expect(messages[0]?.unsent).toBeUndefined()
    }
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
