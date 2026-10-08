// Which turn a send a Stop took back before its echo opened, by the turn the host names it answered
// into, and where it is drawn when that turn's record is not loaded.

import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from './agent-session-journal-types'
import { projectNativeChatTranscript } from './native-chat-transcript-projection'
import { nativeChatRowsInDrawOrder } from './native-chat-turn-grouping'
import { nativeChatTurnMembership, structuredAgentTurnAnchors } from './native-chat-turn-membership'
import { DISPATCH_REJECTED_CANCELLED } from './structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const STOPPED_ROW = 'stopped-before-start:'
const key = agentJournalSubmissionKey

function row(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope = { kind: 'thread' }
): AgentJournalRenderItem {
  return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope }
}

const sent = (id: string, sequence: number, turnScope?: AgentJournalTurnScope) =>
  row(
    key(id),
    sequence,
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] },
    turnScope
  )

const turn = (itemId: string, sequence: number, userItemId: string, startedAt?: number) =>
  row(itemId, sequence, {
    kind: 'turn',
    turnId: itemId,
    state: 'interrupted',
    outcome: 'cancellation',
    userItemId,
    ...(startedAt !== undefined ? { startedAt } : {})
  })

const stopNote = (turnItemId: string, sequence: number) =>
  row(
    `stop:${turnItemId}`,
    sequence,
    { kind: 'status', text: 'Cancellation requested.' },
    {
      kind: 'turn',
      turnItemId
    }
  )

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2,
    ...overrides
  }
}

const stopped = (id: string, overrides: Partial<AgentJournalSubmission> = {}) =>
  submission(id, { dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED, ...overrides })

/** Row ids in the order the transcript draws them, and each row's turn. */
function drawn(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]) {
  const journal = { items, submissions }
  const { conversation } = projectNativeChatTranscript(
    projectStructuredAgentSessionMessages(items, [], submissions, { rejectedInPlace: false }),
    undefined,
    journal
  )
  const { drawOrder, turnKeys } = nativeChatTurnMembership(conversation, journal)
  const turnOf = new Map(conversation.map((message, index) => [message.id, turnKeys[index]]))
  return nativeChatRowsInDrawOrder(conversation, drawOrder).map((message) => ({
    id: message.id,
    turn: turnOf.get(message.id)
  }))
}

describe('a send a Stop took back before its echo', () => {
  it('opens the turn the host names, not an earlier send taken back across it', () => {
    // `queued` was sent first and taken back after the record too, but the host names `opener`.
    // Both rows sit where they were taken back.
    const items = [
      turn('t1', 3, 'codex:thread-1:t1:0'),
      stopNote('t1', 4),
      sent('queued', 5),
      sent('opener', 6)
    ]
    const submissions = [
      stopped('queued', { submittedSequence: 1, answeredInTurn: null }),
      stopped('opener', {
        submittedSequence: 2,
        answeredInTurn: { turnItemId: 't1', via: 'start' }
      })
    ]

    expect(structuredAgentTurnAnchors(items, submissions).get('t1')).toBe(key('opener'))
    expect(drawn(items, submissions)).toEqual([
      { id: key('opener'), turn: key('opener') },
      { id: 'stop:t1', turn: key('opener') },
      { id: key('queued'), turn: key('queued') },
      { id: `${STOPPED_ROW}${key('queued')}`, turn: undefined }
    ])
  })

  it('opens no turn whose echoed opener the record names, though the host says it started it', () => {
    // A start Codex folded into a turn already running reads as `start`; the echo still decides.
    const items = [
      sent('opener', 1),
      turn('t1', 2, 'codex:thread-1:t1:0'),
      stopNote('t1', 4),
      sent('folded', 5)
    ]
    const submissions = [
      submission('opener', { submittedSequence: 1, providerItemId: 'codex:thread-1:t1:0' }),
      stopped('folded', {
        submittedSequence: 3,
        answeredInTurn: { turnItemId: 't1', via: 'start' }
      })
    ]

    expect(structuredAgentTurnAnchors(items, submissions).get('t1')).toBe(key('opener'))
    expect(drawn(items, submissions).map(({ id }) => id)).toEqual([
      key('opener'),
      'stop:t1',
      key('folded'),
      `${STOPPED_ROW}${key('folded')}`
    ])
  })

  it('opens no turn the provider resumed on its own, whose record names itself', () => {
    // An older host's clock claim would hand this turn to a send sent before it and taken back after.
    const items = [sent('never-ran', 1), turn('wake', 2, 'wake', 5)]
    const submissions = [stopped('never-ran', { submittedAt: 4, resolvedAt: 10 })]

    expect(structuredAgentTurnAnchors(items, submissions).get('wake')).toBe('wake')
    expect(drawn(items, submissions).map(({ id }) => id)).toEqual([
      key('never-ran'),
      `${STOPPED_ROW}${key('never-ran')}`
    ])
  })

  it('opens no turn the host states it named none for, though it was sent before the record and taken back after', () => {
    // A page whose turn's echoed opener is on an older page: only the record is loaded.
    // Its times would pass an older host's clock claim.
    const items = [turn('t1', 3, 'codex:thread-1:t1:0', 5), stopNote('t1', 4), sent('queued', 5)]
    const submissions = [
      stopped('queued', {
        submittedSequence: 2,
        submittedAt: 4,
        resolvedAt: 10,
        answeredInTurn: null
      })
    ]

    expect(structuredAgentTurnAnchors(items, submissions).get('t1')).toBe('t1')
    expect(drawn(items, submissions).map(({ id }) => id)).toEqual([
      'stop:t1',
      key('queued'),
      `${STOPPED_ROW}${key('queued')}`
    ])
  })

  it('pushes a send taken back inside the turn it opened past that turn, from where it is drawn', () => {
    // `follow-up` was taken back between the record and the opener's own take-back.
    const items = [
      turn('t1', 2, 'codex:thread-1:t1:0'),
      sent('follow-up', 4),
      stopNote('t1', 5),
      sent('opener', 6)
    ]
    const submissions = [
      stopped('opener', {
        submittedSequence: 1,
        answeredInTurn: { turnItemId: 't1', via: 'start' }
      }),
      stopped('follow-up', { submittedSequence: 3, answeredInTurn: null })
    ]

    expect(drawn(items, submissions).map(({ id }) => id)).toEqual([
      key('opener'),
      'stop:t1',
      key('follow-up'),
      `${STOPPED_ROW}${key('follow-up')}`
    ])
  })
})

// Rows a host wrote before it named turns carry neither the turn nor `null`. A newer host still
// publishes where each was sent and has moved its row to the take-back, so journal order places it.
describe('a send a Stop took back before its echo, in history written before the host named turns', () => {
  it('opens the turn recorded after it was sent and before it was taken back', () => {
    const items = [turn('t1', 2, 'codex:thread-1:t1:0'), stopNote('t1', 3), sent('opener', 4)]
    const submissions = [stopped('opener', { submittedSequence: 1 })]

    expect(drawn(items, submissions).map(({ id }) => id)).toEqual([key('opener'), 'stop:t1'])
  })

  it('opens it as the first sent, leaving a later send its own row after the turn', () => {
    const items = [
      turn('t1', 3, 'codex:thread-1:t1:0'),
      stopNote('t1', 4),
      sent('opener', 5),
      sent('follow-up', 6)
    ]
    const submissions = [
      stopped('follow-up', { submittedSequence: 2, submittedAt: 1 }),
      stopped('opener', { submittedSequence: 1, submittedAt: 2 })
    ]

    expect(drawn(items, submissions).map(({ id }) => id)).toEqual([
      key('opener'),
      'stop:t1',
      key('follow-up'),
      `${STOPPED_ROW}${key('follow-up')}`
    ])
  })

  it('opens no turn recorded before it was sent', () => {
    const items = [turn('t1', 1, 'codex:thread-1:t1:0'), stopNote('t1', 3), sent('late', 4)]
    const submissions = [stopped('late', { submittedSequence: 2 })]

    expect(structuredAgentTurnAnchors(items, submissions).get('t1')).toBe('t1')
  })
})

describe('a send a Stop took back that the host stated was answered into no turn', () => {
  it('opens no turn the provider resumed on its own, as a Claude rejection reads', () => {
    const items = [
      turn('wake', 2, 'wake', 5),
      sent('never-ran', 3),
      row(
        'wake-note',
        4,
        { kind: 'status', text: 'Background task finished.' },
        {
          kind: 'turn',
          turnItemId: 'wake'
        }
      )
    ]
    const submissions = [
      stopped('never-ran', {
        submittedSequence: 1,
        submittedAt: 4,
        resolvedAt: 10,
        answeredInTurn: null
      })
    ]

    expect(structuredAgentTurnAnchors(items, submissions).get('wake')).toBe('wake')
    expect(drawn(items, submissions).map(({ id }) => id)).toContain(
      `${STOPPED_ROW}${key('never-ran')}`
    )
  })

  it('opens no turn a later Codex record names by key', () => {
    const items = [turn('t1', 2, 'codex:thread-1:t1:0'), stopNote('t1', 3), sent('queued', 4)]
    const submissions = [stopped('queued', { submittedSequence: 1, answeredInTurn: null })]

    expect(structuredAgentTurnAnchors(items, submissions).get('t1')).toBe('t1')
    expect(drawn(items, submissions).map(({ id }) => id)).toEqual([
      'stop:t1',
      key('queued'),
      `${STOPPED_ROW}${key('queued')}`
    ])
  })

  it('opens no turn when it names a way of joining this build does not know', () => {
    const items = [turn('t1', 2, 'codex:thread-1:t1:0'), stopNote('t1', 3), sent('later', 4)]
    const submissions = [
      stopped('later', {
        submittedSequence: 1,
        // A newer host's value, which this build's type does not name.
        answeredInTurn: JSON.parse('{"turnItemId":"t1","via":"resume"}')
      })
    ]

    expect(structuredAgentTurnAnchors(items, submissions).get('t1')).toBe('t1')
  })
})

describe('a steer a Stop took back before its echo', () => {
  const started = { turnItemId: 't1', via: 'start' } as const
  const steered = { turnItemId: 't1', via: 'steer' } as const

  it('opens no turn whose echoed opener the record names, and is drawn after it', () => {
    const items = [
      sent('opener', 1),
      turn('t1', 2, 'codex:thread-1:t1:0'),
      stopNote('t1', 4),
      sent('steer', 5)
    ]
    const submissions = [
      submission('opener', { submittedSequence: 1, providerItemId: 'codex:thread-1:t1:0' }),
      stopped('steer', { submittedSequence: 3, answeredInTurn: steered })
    ]

    expect(structuredAgentTurnAnchors(items, submissions).get('t1')).toBe(key('opener'))
    expect(drawn(items, submissions)).toEqual([
      { id: key('opener'), turn: key('opener') },
      { id: 'stop:t1', turn: key('opener') },
      { id: key('steer'), turn: key('steer') },
      { id: `${STOPPED_ROW}${key('steer')}`, turn: undefined }
    ])
  })

  it('leaves the turn to the send that started it when both were taken back', () => {
    const items = [
      turn('t1', 2, 'codex:thread-1:t1:0'),
      stopNote('t1', 4),
      sent('steer', 5),
      sent('opener', 6)
    ]
    const submissions = [
      stopped('opener', { submittedSequence: 1, answeredInTurn: started }),
      stopped('steer', { submittedSequence: 3, answeredInTurn: steered })
    ]

    expect(structuredAgentTurnAnchors(items, submissions).get('t1')).toBe(key('opener'))
    expect(drawn(items, submissions)).toEqual([
      { id: key('opener'), turn: key('opener') },
      { id: 'stop:t1', turn: key('opener') },
      { id: key('steer'), turn: key('steer') },
      { id: `${STOPPED_ROW}${key('steer')}`, turn: undefined }
    ])
  })

  it('opens no turn whose echoed opener is on an older page, and is drawn after it', () => {
    // Only the record is loaded: the opener's row and submission are on the older page.
    const items = [turn('t1', 2, 'codex:thread-1:t1:0'), stopNote('t1', 4), sent('steer', 5)]
    const submissions = [stopped('steer', { submittedSequence: 1, answeredInTurn: steered })]

    expect(structuredAgentTurnAnchors(items, submissions).get('t1')).toBe('t1')
    expect(drawn(items, submissions).map(({ id }) => id)).toEqual([
      'stop:t1',
      key('steer'),
      `${STOPPED_ROW}${key('steer')}`
    ])
  })

  it('keeps its own row on a page that starts inside the turn it joined', () => {
    const items = [stopNote('t1', 4), sent('steer', 5)]
    const submissions = [stopped('steer', { submittedSequence: 1, answeredInTurn: steered })]

    expect(drawn(items, submissions).map(({ id }) => id)).toEqual([
      'stop:t1',
      key('steer'),
      `${STOPPED_ROW}${key('steer')}`
    ])
  })
})

describe('a send a Stop took back on a page that starts inside the turn it opened', () => {
  it("is drawn before that turn's first loaded row, with no row of its own", () => {
    const items = [stopNote('t1', 4), sent('opener', 5)]
    const submissions = [
      stopped('opener', {
        submittedSequence: 1,
        answeredInTurn: { turnItemId: 't1', via: 'start' }
      })
    ]

    expect(drawn(items, submissions).map(({ id }) => id)).toEqual([key('opener'), 'stop:t1'])
  })

  it('keeps its own row when a loaded message of that turn opened it instead', () => {
    const items = [
      sent('steered', 3, { kind: 'turn', turnItemId: 't1' }),
      stopNote('t1', 4),
      sent('late', 5)
    ]
    const submissions = [
      submission('steered', { submittedSequence: 3 }),
      stopped('late', { submittedSequence: 2, answeredInTurn: { turnItemId: 't1', via: 'start' } })
    ]

    expect(drawn(items, submissions).map(({ id }) => id)).toEqual([
      key('steered'),
      'stop:t1',
      key('late'),
      `${STOPPED_ROW}${key('late')}`
    ])
  })
})
