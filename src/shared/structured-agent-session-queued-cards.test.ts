import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionQueuedMessage } from './agent-session-wire'
import {
  newestSteerableQueuedMessageCard,
  projectQueuedMessageCards,
  queuedMessagesQueuePause
} from './structured-agent-session-queued-cards'

function draft(
  id: string,
  position: number,
  overrides: Partial<AgentSessionQueuedMessage> = {}
): AgentSessionQueuedMessage {
  return {
    messageId: id,
    position,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `text of ${id}` }] },
    state: 'waiting',
    ...overrides
  }
}

function submission(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState'] = 'pending',
  queuedMessageId?: string
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    ...(queuedMessageId !== undefined ? { queuedMessageId } : {})
  }
}

function handOff(
  draftId: string,
  dispatchState: AgentJournalSubmission['dispatchState'] = 'pending',
  id = `${draftId}-hand-off`
): AgentJournalSubmission {
  return submission(id, dispatchState, draftId)
}

const IDLE = {}

describe('queued message cards', () => {
  it('a returned card carries its stored reason and blocks the label of drafts behind it', () => {
    const cards = projectQueuedMessageCards(
      [
        draft('failed', 1, {
          state: 'returned',
          returnedReason: 'agent_session_write_failed',
          returnedRejection: { kind: 'writeFailed' }
        }),
        draft('behind', 2)
      ],
      [],
      IDLE
    )
    expect(cards[0]).toMatchObject({
      state: 'returned',
      hold: 'returned',
      returnedReason: 'agent_session_write_failed',
      returnedRejection: { kind: 'writeFailed' }
    })
    expect(cards[1]?.hold).toBe('behind-returned')
  })

  it('shows a draft a Stop put back: its rejected hand-off is what sent it back', () => {
    // The Stop pause belongs to the queue, so the draft itself carries no hold.
    const requeued = draft('requeued', 1)
    expect(
      projectQueuedMessageCards([requeued], [handOff('requeued', 'rejected')], IDLE)
    ).toMatchObject([{ messageId: 'requeued', state: 'waiting' }])
    for (const dispatchState of ['pending', 'accepted'] as const) {
      expect(
        projectQueuedMessageCards([requeued], [handOff('requeued', dispatchState)], IDLE)
      ).toEqual([])
    }
  })

  it('requeued and drained again under a fresh id, the card and the bubble never show together', () => {
    // A multi-page catch-up: the new hand-off's bubble arrives before the list that drops the card.
    const cards = projectQueuedMessageCards(
      [draft('requeued', 1)],
      [handOff('requeued', 'rejected', 'first'), handOff('requeued', 'pending', 'second')],
      IDLE
    )
    expect(cards).toEqual([])
  })

  it('hides a waiting card only by the link, never by a submission id that equals the draft id', () => {
    const cards = projectQueuedMessageCards(
      [
        draft('consumed', 1),
        draft('kept', 2),
        draft('refused', 3, { state: 'returned', returnedReason: null })
      ],
      [handOff('consumed'), submission('kept'), handOff('refused', 'rejected')],
      IDLE
    )
    expect(cards.map((card) => card.messageId)).toEqual(['kept', 'refused'])
  })

  it("a paused queue holds its waiting cards; a card's own hold or return still shows", () => {
    const cards = projectQueuedMessageCards(
      [
        draft('waiting', 1),
        draft('failed', 2, { paused: true, pausedReason: 'send_failed' }),
        draft('refused', 3, { state: 'returned', returnedReason: null }),
        draft('behind', 4)
      ],
      [],
      { queuePaused: true }
    )
    expect(cards.map((card) => card.hold)).toEqual([
      'queue-paused',
      'paused',
      'returned',
      'behind-returned'
    ])
  })

  it("the header names the queue's pause while it holds a card, and none over cards Resume would not send", () => {
    const stopped = { reason: 'stopped' } as const
    const project = (messages: AgentSessionQueuedMessage[], queuePaused = true) =>
      projectQueuedMessageCards(messages, [], { queuePaused })
    expect(queuedMessagesQueuePause(project([draft('held', 1)]), stopped)).toEqual(stopped)
    const unsendable = [
      draft('returned', 1, { state: 'returned', returnedReason: null }),
      draft('behind', 2),
      draft('failed', 3, { paused: true, pausedReason: 'send_failed' })
    ]
    expect(queuedMessagesQueuePause(project(unsendable), stopped)).toBeNull()
    // No published pause (an idle chat after a restart): plain cards, no header.
    const unpaused = project([draft('waiting', 1)], false)
    expect(unpaused.map((card) => card.hold)).toEqual(['turn'])
    expect(queuedMessagesQueuePause(unpaused, null)).toBeNull()
  })

  it('a card behind a card held on its own is not held by it', () => {
    const cards = projectQueuedMessageCards(
      [
        draft('failed', 1, { paused: true, pausedReason: 'send_failed' }),
        draft('after-failed', 2),
        draft('newer-hold', 3, { paused: true }),
        draft('behind', 4)
      ],
      [],
      IDLE
    )
    expect(cards.map((card) => card.hold)).toEqual(['paused', 'turn', 'paused', 'turn'])
  })

  it('marks a command card, which the chord never steers', () => {
    const compact: AgentSessionQueuedMessage = {
      ...draft('c', 2),
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/compact' }],
        command: { name: 'compact' }
      }
    }
    const cards = projectQueuedMessageCards([draft('a', 1), compact], [], IDLE)
    expect(cards.map((card) => [card.text, card.command ?? false])).toEqual([
      ['text of a', false],
      ['/compact', true]
    ])
    expect(newestSteerableQueuedMessageCard(cards)).toBeNull()
    // While the agent works it offers no send; a message card is unaffected.
    const working = projectQueuedMessageCards([draft('a', 1), compact], [], {
      ...IDLE,
      agentWorking: true
    })
    expect(working.map((card) => card.waitsForAgent ?? false)).toEqual([false, true])
    expect(cards[1]).not.toHaveProperty('waitsForAgent')
  })
})
