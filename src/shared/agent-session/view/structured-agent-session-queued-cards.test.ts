import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../journal/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../requests/agent-session-queued-message-wire'
import {
  headSteerableQueuedMessageCard,
  projectQueuedMessageCards
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
    // A command at the head steers nothing, and the chord never reaches past it.
    expect(headSteerableQueuedMessageCard([cards[1]!, cards[0]!])).toBeNull()
    // While the agent works it offers no send; a message card is unaffected.
    const working = projectQueuedMessageCards([draft('a', 1), compact], [], {
      ...IDLE,
      agentWorking: true
    })
    expect(working.map((card) => card.waitsForAgent ?? false)).toEqual([false, true])
    expect(cards[1]).not.toHaveProperty('waitsForAgent')
  })
})
