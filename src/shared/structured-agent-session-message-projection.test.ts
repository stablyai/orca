// A send the host kept as a card is drawn only as that card: the rule rides on the submission's
// own fact, never on the card still being there.

import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { structuredAgentSessionSendBody } from './structured-agent-session-send-mutation'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import { DISPATCH_REJECTED_CANCELLED } from './structured-agent-session-dispatch-rejection'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'

const KEPT_ID = 'client-kept'
// The desktop draws a rejected send in place, as not sent, unless the host kept it as a card.
const DESKTOP = { rejectedInPlace: true }

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
    expect(projectStructuredAgentSessionMessages(items, [lingeringCopy], [kept], DESKTOP)).toEqual(
      []
    )
    // A rejection with no card is drawn from the host's row, marked not sent.
    expect(
      projectStructuredAgentSessionMessages(items, [lingeringCopy], [rejected()], DESKTOP)
    ).toEqual([expect.objectContaining({ id: agentJournalSubmissionKey(KEPT_ID), unsent: true })])
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
      [kept, edited],
      DESKTOP
    )
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ blocks: [{ text: 'the edited words' }] })
    expect(shown[0]).not.toHaveProperty('unsent')
  })
})

// The phone draws this list as it comes, so the projection itself must place a not-sent row.
describe('a send the host recorded and then rejected', () => {
  it('stays where the host placed it, above what came after, and above a held send', () => {
    const answer: AgentJournalRenderItem = {
      itemId: 'answer-3',
      revision: 1,
      sequence: 3,
      observedAt: 3,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Yes' }] }
    }
    const later: AgentJournalSubmission = {
      ...rejected({ clientMessageId: 'client-later', payloadFingerprint: 'fingerprint-later' }),
      dispatchState: 'accepted',
      providerItemId: 'provider-later',
      reason: null
    }
    delete later.rejection
    const held: AgentJournalSubmission = {
      ...later,
      clientMessageId: 'client-held',
      payloadFingerprint: 'fingerprint-held',
      dispatchState: 'pending',
      providerItemId: null,
      handoverRecorded: true
    }
    const shown = projectStructuredAgentSessionMessages(
      [
        userItem(KEPT_ID, 'hello', 1),
        userItem('client-later', 'are you there?', 2),
        answer,
        userItem('client-held', 'next', 4)
      ],
      [],
      [rejected(), later, held],
      DESKTOP
    )
    expect(shown.map((message) => [message.id, message.unsent ?? message.queued ?? false])).toEqual(
      [
        [agentJournalSubmissionKey(KEPT_ID), true],
        [agentJournalSubmissionKey('client-later'), false],
        ['answer-3', false],
        [agentJournalSubmissionKey('client-held'), true]
      ]
    )
  })
})

// A not-sent row joins the conversation after the stop rows are placed, so the rows a run of
// stopped sends ends with stay as they were without it.
describe('a not-sent row between two stopped sends', () => {
  const items = [
    userItem('client-s1', 'a', 3),
    userItem(KEPT_ID, 'b', 4),
    userItem('client-s2', 'c', 5)
  ]
  const stopped = (clientMessageId: string): AgentJournalSubmission => ({
    ...rejected({ clientMessageId, payloadFingerprint: `fingerprint-${clientMessageId}` }),
    reason: DISPATCH_REJECTED_CANCELLED,
    rejection: { kind: 'cancelled' }
  })
  const submissions = [stopped('client-s1'), rejected(), stopped('client-s2')]
  const drawnOrder = (messages: readonly { id: string; unsent?: true }[]) =>
    messages.map((message) => `${message.id}${message.unsent ? ' (not sent)' : ''}`)

  it('sits at its journal place without splitting the run: one stop row, after the last', () => {
    expect(
      drawnOrder(projectStructuredAgentSessionMessages(items, [], submissions, DESKTOP))
    ).toEqual([
      agentJournalSubmissionKey('client-s1'),
      `${agentJournalSubmissionKey(KEPT_ID)} (not sent)`,
      agentJournalSubmissionKey('client-s2'),
      `stopped-before-start:${agentJournalSubmissionKey('client-s2')}`
    ])
  })

  it('keeps a stop row whose send has no journal place right after that send', () => {
    const unplaced = (input: readonly AgentJournalRenderItem[]) =>
      projectStructuredItemsToNativeChat(input).map((message) =>
        message.id === agentJournalSubmissionKey(KEPT_ID)
          ? message
          : { ...message, journalPosition: undefined }
      )
    expect(
      drawnOrder(projectStructuredAgentSessionMessages(items, [], submissions, DESKTOP, unplaced))
    ).toEqual([
      agentJournalSubmissionKey('client-s1'),
      agentJournalSubmissionKey('client-s2'),
      `stopped-before-start:${agentJournalSubmissionKey('client-s2')}`,
      `${agentJournalSubmissionKey(KEPT_ID)} (not sent)`
    ])
  })
})
