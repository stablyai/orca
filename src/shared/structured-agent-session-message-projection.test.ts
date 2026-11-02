// A send the host kept as a card is drawn only as that card: the rule rides on the submission's
// own fact, never on the card still being there.

import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { structuredAgentSessionSendBody } from './structured-agent-session-send-mutation'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import { projectNativeChatTranscriptMessages } from './native-chat-transcript-projection'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_WRITE_FAILED
} from './structured-agent-session-dispatch-rejection'
import { withNativeChatCutTurnNotices } from './native-chat-cut-turn-notice'
import { agentSessionFailureFact } from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'

const KEPT_ID = 'client-kept'

function rejected(fields: Partial<AgentJournalSubmission> = {}): AgentJournalSubmission {
  return {
    clientMessageId: KEPT_ID,
    fence: 1,
    payloadFingerprint: 'fingerprint-kept',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: 'Orca restarted before this message was sent.',
    rejection: { kind: 'hostRestarted' },
    submittedAt: 1,
    resolvedAt: 2,
    ...fields
  }
}

function userItem(id: string, text: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(id),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  }
}

/** The sending desktop's own bubble, had it not settled yet. */
const lingeringCopy = {
  clientMessageId: KEPT_ID,
  body: structuredAgentSessionSendBody('the kept words', []),
  queuedAt: 1
}

describe('a send kept as a card', () => {
  it('shows nothing of the original send, even beside its own local copy', () => {
    const kept = rejected({ keptAsQueuedMessageId: KEPT_ID })
    const items = [userItem(KEPT_ID, 'the kept words', 1)]
    expect(projectStructuredAgentSessionMessages(items, [lingeringCopy], [kept])).toEqual([])
    // A rejection with no card is drawn from the host's row, marked not sent.
    expect(projectStructuredAgentSessionMessages(items, [lingeringCopy], [rejected()])).toEqual([
      expect.objectContaining({ id: agentJournalSubmissionKey(KEPT_ID), unsent: true })
    ])
  })

  // Edit is the card's text in the composer, then the card's Delete, then a new send.
  it('after an Edit sent again, shows exactly the new send', () => {
    const kept = rejected({ keptAsQueuedMessageId: KEPT_ID })
    const edited: AgentJournalSubmission = {
      ...rejected(),
      clientMessageId: 'client-edited',
      dispatchState: 'accepted',
      providerItemId: 'provider-edited',
      reason: null
    }
    delete edited.rejection
    const shown = projectStructuredAgentSessionMessages(
      [userItem(KEPT_ID, 'the kept words', 1), userItem('client-edited', 'the edited words', 2)],
      [lingeringCopy],
      [kept, edited]
    )
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ blocks: [{ text: 'the edited words' }] })
    expect(shown[0]).not.toHaveProperty('unsent')
  })
})

describe('a not-sent row', () => {
  const said = (id: string, text: string, sequence: number): AgentJournalRenderItem => ({
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  })
  const delivered = (id: string, submittedAt: number): AgentJournalSubmission => ({
    ...rejected({ clientMessageId: id, payloadFingerprint: id, submittedAt }),
    dispatchState: 'accepted',
    reason: null,
    rejection: undefined
  })
  const items = [
    userItem('first', 'first', 1),
    said('reply-1', 'one', 2),
    userItem(KEPT_ID, 'not sent', 3),
    userItem('later', 'later', 4),
    said('reply-2', 'two', 5)
  ]
  const submissions = [delivered('first', 1), rejected(), delivered('later', 3)]

  // The phone draws the list as given, so the projection itself puts the row in place.
  it('is listed where the host recorded it, not after later turns', () => {
    const shown = projectStructuredAgentSessionMessages(items, [], submissions)
    expect(shown.map((message) => [message.id, message.unsent ?? false])).toEqual([
      [agentJournalSubmissionKey('first'), false],
      ['reply-1', false],
      [agentJournalSubmissionKey(KEPT_ID), true],
      [agentJournalSubmissionKey('later'), false],
      ['reply-2', false]
    ])
    // The desktop sorts by the same order, so what it draws is unchanged.
    expect(projectNativeChatTranscriptMessages(shown).map((message) => message.id)).toEqual(
      shown.map((message) => message.id)
    )
  })

  it('follows the stop row of a send taken back before it', () => {
    const stoppedId = 'stopped'
    const shown = projectStructuredAgentSessionMessages(
      [userItem(stoppedId, 'taken back', 1), userItem(KEPT_ID, 'not sent', 2)],
      [],
      [
        rejected({
          clientMessageId: stoppedId,
          payloadFingerprint: stoppedId,
          reason: DISPATCH_REJECTED_CANCELLED,
          rejection: undefined
        }),
        rejected({ submittedAt: 3 })
      ]
    )
    expect(shown.map((message) => message.id)).toEqual([
      agentJournalSubmissionKey(stoppedId),
      `stopped-before-start:${agentJournalSubmissionKey(stoppedId)}`,
      agentJournalSubmissionKey(KEPT_ID)
    ])
  })

  // The merge relies on the rest of the list already being in journal order; this pins it.
  it('lists everything in the order the desktop sorts it into', () => {
    const row = (
      itemId: string,
      sequence: number,
      body: AgentJournalItemBody,
      turnItemId?: string
    ): AgentJournalRenderItem => ({
      itemId,
      revision: 1,
      sequence,
      observedAt: sequence,
      body,
      turnScope: turnItemId ? { kind: 'turn', turnItemId } : { kind: 'thread' }
    })
    const user = (id: string, sequence: number): AgentJournalRenderItem =>
      row(agentJournalSubmissionKey(id), sequence, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: id }]
      })
    const reply = (id: string, sequence: number, turnItemId: string): AgentJournalRenderItem =>
      row(
        id,
        sequence,
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: id }] },
        turnItemId
      )
    const retry = (id: string, sequence: number): AgentJournalRenderItem =>
      row(
        id,
        sequence,
        {
          kind: 'status',
          tone: 'warning',
          ...agentSessionFailureWords(agentSessionFailureFact('providerRetrying'), {
            surface: 'row'
          })
        },
        'turn-a'
      )
    const turn = (
      turnId: string,
      sequence: number,
      opener: string,
      state: 'completed' | 'interrupted'
    ): AgentJournalRenderItem =>
      row(turnId, sequence, {
        kind: 'turn',
        turnId,
        state,
        userItemId: agentJournalSubmissionKey(opener)
      })
    const send = (
      id: string,
      sequence: number,
      fields: Partial<AgentJournalSubmission> = {}
    ): AgentJournalSubmission => ({
      ...rejected({ clientMessageId: id, payloadFingerprint: id, submittedAt: sequence }),
      dispatchState: 'accepted',
      reason: null,
      rejection: undefined,
      submittedSequence: sequence,
      ...fields
    })
    const items = withNativeChatCutTurnNotices([
      user('a', 1),
      turn('turn-a', 2, 'a', 'completed'),
      user('stopped', 3),
      reply('reply-a', 4, 'turn-a'),
      retry('retry-1', 5),
      user('unsent-1', 6),
      retry('retry-2', 7),
      user('b', 8),
      turn('turn-b', 9, 'b', 'interrupted'),
      reply('reply-b', 10, 'turn-b'),
      user('unsent-2', 11),
      user('held', 12)
    ])
    const notSent = { dispatchState: 'rejected' as const, reason: DISPATCH_REJECTED_WRITE_FAILED }
    const shown = projectStructuredAgentSessionMessages(
      items,
      [],
      [
        send('a', 1),
        send('stopped', 3, { dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED }),
        send('unsent-1', 6, notSent),
        send('b', 8),
        send('unsent-2', 11, notSent),
        send('held', 12, { dispatchState: 'pending', handoverRecorded: true, resolvedAt: null })
      ]
    )
    const ids = shown.map((message) => message.id)
    expect(ids).toEqual([
      agentJournalSubmissionKey('a'),
      'reply-a',
      agentJournalSubmissionKey('unsent-1'),
      // The run's earlier retry row is collapsed into this one.
      'retry-2',
      // Moved past the end of the turn it was sent into.
      agentJournalSubmissionKey('stopped'),
      `stopped-before-start:${agentJournalSubmissionKey('stopped')}`,
      agentJournalSubmissionKey('b'),
      'reply-b',
      agentJournalSubmissionKey('cut-turn-notice:turn-b'),
      agentJournalSubmissionKey('unsent-2'),
      agentJournalSubmissionKey('held')
    ])
    // The desktop sorts held cards after the conversation, and the rest by journal place.
    const conversation = shown.filter((message) => !message.queued)
    expect(projectNativeChatTranscriptMessages(conversation).map((message) => message.id)).toEqual(
      conversation.map((message) => message.id)
    )
    expect(shown.at(-1)).toMatchObject({ queued: true })
  })
})
