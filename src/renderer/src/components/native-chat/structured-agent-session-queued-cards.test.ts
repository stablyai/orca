// Card projection policy: queue order, derived hold labels (the wire carries
// holds, not labels), and the presentation-only suppression of a card whose submission
// already arrived — a queued draft is otherwise never a transcript bubble.

import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import {
  newestSteerableQueuedMessageCard,
  pendingSendsOutsideQueuedCards,
  pendingQueueSendsOnTheirWay,
  projectQueuedMessageCards,
  queuedMessageCardSteers,
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

/** The host's hand-off of draft `draftId`, always under a submission id of its own. */
function handOff(
  draftId: string,
  dispatchState: AgentJournalSubmission['dispatchState'] = 'pending',
  id = `${draftId}-hand-off`
): AgentJournalSubmission {
  return submission(id, dispatchState, draftId)
}

const IDLE = {}

describe('queued message cards', () => {
  it('orders by host position whatever order the list arrives in', () => {
    const cards = projectQueuedMessageCards([draft('b', 2), draft('a', 1), draft('c', 3)], [], IDLE)
    expect(cards.map((card) => card.messageId)).toEqual(['a', 'b', 'c'])
    expect(cards[0]?.text).toBe('text of a')
  })

  it('holds: a waiting card waits its turn', () => {
    expect(projectQueuedMessageCards([draft('a', 1)], [], IDLE)[0]?.hold).toBe('turn')
  })

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

  it('a paused draft says so, carrying the host marker for the caption to localize', () => {
    const cards = projectQueuedMessageCards(
      [draft('a', 1, { paused: true, pausedReason: 'send_failed' })],
      [],
      IDLE
    )
    expect(cards[0]).toMatchObject({ hold: 'paused', pausedReason: 'send_failed' })
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

  it('a paused queue holds every waiting card, in order', () => {
    const cards = projectQueuedMessageCards([draft('held', 1), draft('typed-after', 2)], [], {
      queuePaused: true
    })
    expect(cards.map((card) => card.hold)).toEqual(['queue-paused', 'queue-paused'])
    // Still Steer: the header row, not the card, says it waits.
    expect(cards.map((card) => queuedMessageCardSteers(card))).toEqual([true, true])
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

  // A card held on its own (a failed send, or a newer host's hold) holds nothing behind it.
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

  it('steers the newest card', () => {
    const cards = projectQueuedMessageCards([draft('a', 1), draft('b', 2)], [], IDLE)
    expect(newestSteerableQueuedMessageCard(cards)?.messageId).toBe('b')
    expect(newestSteerableQueuedMessageCard([])).toBeNull()
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

  it('a mid-turn queue send on its way is no bubble; a plain or recorded one is, until its row', () => {
    const entry = (
      clientMessageId: string,
      overrides: Partial<StructuredAgentSessionPendingSend> = {}
    ): StructuredAgentSessionPendingSend => ({
      clientMessageId,
      sessionId: 'session-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
      previewUris: [],
      queuedAt: 1,
      phase: 'sending',
      issued: true,
      ...overrides
    })
    const ids = (entries: readonly StructuredAgentSessionPendingSend[]): string[] =>
      entries.map((candidate) => candidate.clientMessageId)
    const sends = [
      entry('queued', { delivery: 'queue-if-active' }),
      entry('plain'),
      entry('recorded', { phase: 'recorded' })
    ]
    // Its card draws a queue send while the agent works; a plain send stays in view, and so does a
    // recorded one until its row arrives (the transcript drops it then).
    expect(ids(pendingSendsOutsideQueuedCards(sends, [], true))).toEqual(['plain', 'recorded'])
    expect(ids(pendingSendsOutsideQueuedCards(sends, [], false))).toEqual([
      'queued',
      'plain',
      'recorded'
    ])
    // Once the host visibly holds it, it is a card.
    expect(ids(pendingSendsOutsideQueuedCards(sends, ['plain'], false))).toEqual([
      'queued',
      'recorded'
    ])
  })
  it('a sending card ends once the host records the send or hands its card off', () => {
    const entry: StructuredAgentSessionPendingSend = {
      clientMessageId: 'a',
      sessionId: 'session-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'a' }] },
      previewUris: [],
      queuedAt: 1,
      phase: 'sending',
      issued: true,
      delivery: 'queue-if-active'
    }
    const onItsWay = (submissions: AgentJournalSubmission[]) =>
      pendingQueueSendsOnTheirWay([entry], [], true, submissions).map(
        (candidate) => candidate.clientMessageId
      )
    expect(onItsWay([])).toEqual(['a'])
    expect(onItsWay([submission('a')])).toEqual([])
    expect(onItsWay([handOff('a')])).toEqual([])
    expect(pendingQueueSendsOnTheirWay([entry], ['a'], true, [])).toEqual([])
    expect(pendingQueueSendsOnTheirWay([entry], [], false, [])).toEqual([])
    expect(pendingQueueSendsOnTheirWay([{ ...entry, phase: 'recorded' }], [], true, [])).toEqual([])
  })
})

describe("another agent's card", () => {
  it('carries who it is from, read through the shared reader', () => {
    const from = {
      kind: 'agent' as const,
      senders: [
        {
          party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
          name: 'Coder'
        }
      ],
      orchestration: null
    }
    const agentDraft = draft('a', 1)
    const cards = projectQueuedMessageCards(
      [{ ...agentDraft, body: { ...agentDraft.body, from } }, draft('b', 2)],
      [],
      IDLE
    )
    expect(cards.map((card) => card.from)).toEqual([from, undefined])
  })
})
