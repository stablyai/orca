// Stopped-before-start sends keep their original place plus one notice; the journal already holds the send and refusal.

import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import type {
  AgentJournalAnsweredTurn,
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../journal/agent-session-journal-turn-scope'
import '../../native-chat/native-chat-stopped-before-start'
import { DISPATCH_REJECTED_CANCELLED } from '../requests/structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionMessages } from '../view/structured-agent-session-message-projection'
import {
  projectNativeChatTranscript,
  projectNativeChatTranscriptMessages
} from '../../native-chat/transcript/native-chat-transcript-projection'
import { nativeChatRowsInDrawOrder } from '../../native-chat/transcript/native-chat-turn-grouping'
import { nativeChatTurnMembership } from '../../native-chat/transcript/native-chat-turn-membership'

let sequence = 0

function entry(
  itemId: string,
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope = { kind: 'thread' }
): AgentJournalRenderItem {
  sequence += 1
  return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope }
}

const said = (itemId: string, text: string, turnItemId: string) =>
  entry(
    itemId,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    { kind: 'turn', turnItemId }
  )

const sent = (id: string, text: string) =>
  entry(agentJournalSubmissionKey(id), {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })

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

function rows(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]) {
  return projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(items, [], submissions)
  ).map((message) => ({ id: message.id, role: message.role }))
}

const user = (id: string) => ({ id: agentJournalSubmissionKey(id), role: 'user' })
const stopRow = (id: string) => ({
  id: `stopped-before-start:${agentJournalSubmissionKey(id)}`,
  role: 'system'
})

/** Test published send placement and the Temporary older-host fallback. */
const HOSTS = [
  ['a host that publishes where it was sent', true],
  ['an older host', false]
] as const

/** Publishing hosts move withdrawn sends to the take-back row, outside turns, and name the answered turn; old hosts retain send placement. */
function takenBackOn(
  published: boolean,
  items: AgentJournalRenderItem[],
  id: string,
  at: number,
  answeredInTurn: AgentJournalAnsweredTurn | null = null
): { items: AgentJournalRenderItem[]; sent: Partial<AgentJournalSubmission> } {
  const key = agentJournalSubmissionKey(id)
  const row = items.find((item) => item.itemId === key)!
  if (!published) {
    return { items, sent: {} }
  }
  const moved = items.map((item) =>
    item.itemId === key
      ? { ...item, sequence: at, observedAt: at, turnScope: { kind: 'thread' as const } }
      : item
  )
  return {
    items: moved.sort((left, right) => left.sequence - right.sequence),
    sent: {
      submittedSequence: row.sequence,
      answeredInTurn
    }
  }
}

describe('a send a Stop took back before the agent started it', () => {
  it('shares one row with the sends taken back right before it', () => {
    const items = [sent('first', 'one'), sent('second', 'two')]

    expect(rows(items, [stopped('first'), stopped('second')])).toEqual([
      user('first'),
      user('second'),
      stopRow('second')
    ])
  })

  // Codex reports the turn open before it echoes the send, so the record names the provider's key.
  it('stays in the turn that opened for it before the provider echoed it', () => {
    const items = [
      sent('opened', 'look around'),
      entry('turn-1', {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'interrupted',
        outcome: 'cancellation',
        userItemId: 'codex:thread-1:turn-1:0',
        startedAt: 5
      })
    ]

    expect(rows(items, [stopped('opened', { resolvedAt: 10 })])).toEqual([user('opened')])
  })

  // Rejected steers leave the joined turn; draw their notice after that turn instead of treating them as openers.
  it.each(HOSTS)(
    'draws a steer it took back after the turn it joined, with its own row, on %s',
    (_host, published) => {
      const steered = [
        sent('first', 'look around'),
        entry('t1', {
          kind: 'turn',
          turnId: 't1',
          state: 'interrupted',
          outcome: 'cancellation',
          userItemId: agentJournalSubmissionKey('first')
        }),
        entry(
          agentJournalSubmissionKey('steer'),
          {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'and check the tests' }]
          },
          { kind: 'turn', turnItemId: 't1' }
        ),
        entry(
          'stop:t1',
          { kind: 'status', text: 'Cancellation requested.' },
          { kind: 'turn', turnItemId: 't1' }
        )
      ]
      const { items, sent: steer } = takenBackOn(published, steered, 'steer', sequence + 1, {
        turnItemId: 't1',
        via: 'steer'
      })

      expect(rows(items, [submission('first'), stopped('steer', steer)])).toEqual([
        user('first'),
        { id: 'stop:t1', role: 'system' },
        user('steer'),
        stopRow('steer')
      ])
    }
  )

  // Moving an opener past its turn record must not erase which turn it opened.
  it('stays in the turn it opened when its row moved past that turn to the take-back', () => {
    const opened = [
      sent('opened', 'look around'),
      entry('turn-1', {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'interrupted',
        outcome: 'cancellation',
        userItemId: 'codex:thread-1:turn-1:0'
      }),
      entry(
        'stop:turn-1',
        { kind: 'status', text: 'Cancellation requested.' },
        { kind: 'turn', turnItemId: 'turn-1' }
      )
    ]
    const { items, sent: position } = takenBackOn(true, opened, 'opened', sequence + 1, {
      turnItemId: 'turn-1',
      via: 'start'
    })

    expect(rows(items, [stopped('opened', position)])).toEqual([
      user('opened'),
      { id: 'stop:turn-1', role: 'system' }
    ])
  })

  // Restored whole-second turn time precedes Stop, but its journal record follows the take-back row.
  it('keeps its row when the turn record came after the row that took it back', () => {
    const before = [sent('never-ran', 'look around')]
    sequence += 1
    const takenBackAt = sequence
    before.push(
      entry('restored', {
        kind: 'turn',
        turnId: 'turn-9',
        state: 'completed',
        userItemId: 'codex:thread-1:turn-9:0',
        startedAt: 5
      })
    )
    const { items, sent: position } = takenBackOn(true, before, 'never-ran', takenBackAt)

    expect(rows(items, [stopped('never-ran', { resolvedAt: 10, ...position })])).toEqual([
      user('never-ran'),
      stopRow('never-ran')
    ])
  })

  // A provider-opened turn predates this send; take-back movement cannot make the send its opener.
  it('keeps its row when the turn record came before it was sent', () => {
    const before = [
      entry('wake', {
        kind: 'turn',
        turnId: 'wake',
        state: 'completed',
        userItemId: 'codex:thread-1:wake:0'
      }),
      sent('never-ran', 'look around')
    ]
    const { items, sent: position } = takenBackOn(true, before, 'never-ran', sequence + 1)

    expect(rows(items, [stopped('never-ran', position)])).toEqual([
      user('never-ran'),
      stopRow('never-ran')
    ])
  })

  it('keeps its row when a turn starts only after the Stop took it back', () => {
    const items = [
      sent('never-ran', 'look around'),
      entry('wake', {
        kind: 'turn',
        turnId: 'wake',
        state: 'completed',
        userItemId: 'claude:wake',
        startedAt: 20
      }),
      said('wake-note', 'Checking the build.', 'wake')
    ]

    expect(rows(items, [stopped('never-ran', { resolvedAt: 10 })])).toEqual([
      user('never-ran'),
      stopRow('never-ran'),
      { id: 'wake-note', role: 'assistant' }
    ])
  })

  // The first send opens the turn; stopped follow-ups stay below that turn’s rows.
  it("is drawn after a turn that opened while it waited, with that turn's rows above it", () => {
    const items = [
      sent('first', 'look around'),
      sent('follow-up', 'and check the tests'),
      entry('turn-1', {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'interrupted',
        outcome: 'cancellation',
        userItemId: 'codex:thread-1:turn-1:0',
        startedAt: 5
      }),
      entry(
        'stop:turn-1',
        { kind: 'status', text: 'Cancellation requested.' },
        { kind: 'turn', turnItemId: 'turn-1' }
      )
    ]
    const submissions = [
      stopped('first', { resolvedAt: 10 }),
      stopped('follow-up', { resolvedAt: 10 })
    ]
    const journal = { items, submissions }
    const { conversation } = projectNativeChatTranscript(
      projectStructuredAgentSessionMessages(items, [], submissions),
      undefined,
      journal
    )
    const { drawOrder } = nativeChatTurnMembership(conversation, journal)

    expect(nativeChatRowsInDrawOrder(conversation, drawOrder).map((row) => row.id)).toEqual([
      agentJournalSubmissionKey('first'),
      'stop:turn-1',
      agentJournalSubmissionKey('follow-up'),
      `stopped-before-start:${agentJournalSubmissionKey('follow-up')}`
    ])
  })

  // The host's clock stepped back between the two accepts; the journal's order still holds.
  it('keeps two sends in journal order where the host publishes it, whatever the clock says', () => {
    const compactTurn = 'compact-turn'
    const queued = [
      sent('compact', '/compact'),
      entry(compactTurn, {
        kind: 'turn',
        turnId: compactTurn,
        state: 'completed',
        userItemId: agentJournalSubmissionKey('compact')
      }),
      sent('queued-second', 'queued second'),
      said('compacted', 'Context compacted', compactTurn),
      sent('queued-first', 'queued first')
    ]
    const accepted = queued.find(
      (item) => item.itemId === agentJournalSubmissionKey('queued-second')
    )!.sequence
    // Taken back in the opposite order: the second's row lands first.
    const second = takenBackOn(true, queued, 'queued-second', sequence + 1)
    const first = takenBackOn(true, second.items, 'queued-first', sequence + 2)

    expect(
      rows(first.items, [
        submission('compact', { submittedAt: 1 }),
        stopped('queued-first', {
          submittedAt: 9,
          submittedSequence: accepted - 1,
          handoverRecorded: true,
          handedOverAt: 5
        }),
        stopped('queued-second', {
          submittedAt: 3,
          submittedSequence: accepted,
          handoverRecorded: true
        })
      ])
    ).toEqual([
      user('compact'),
      { id: 'compacted', role: 'assistant' },
      user('queued-first'),
      user('queued-second'),
      stopRow('queued-second')
    ])
  })

  // Stop takes back only the unhanded third send, below the finished first and uncertain second.
  it.each(HOSTS)(
    'stays below everything sent before it, a finished exchange included, on %s',
    (_host, published) => {
      const compactTurn = 'compact-turn'
      const items = [
        sent('compact', '/compact'),
        entry(compactTurn, {
          kind: 'turn',
          turnId: compactTurn,
          state: 'completed',
          userItemId: agentJournalSubmissionKey('compact')
        }),
        sent('queued-b', 'queued B'),
        said('compacted', 'Context compacted', compactTurn),
        sent('queued-zero', 'queued zero'),
        sent('queued-a', 'queued A'),
        entry('turn-2', {
          kind: 'turn',
          turnId: 'turn-2',
          state: 'completed',
          userItemId: agentJournalSubmissionKey('queued-zero')
        }),
        said('answer', 'answer to zero', 'turn-2')
      ]

      const host = takenBackOn(published, items, 'queued-b', sequence + 1)

      expect(
        rows(host.items, [
          submission('compact', { submittedAt: 1 }),
          submission('queued-zero', { submittedAt: 2, handoverRecorded: true, handedOverAt: 5 }),
          submission('queued-a', {
            submittedAt: 3,
            dispatchState: 'unknown',
            handoverRecorded: true,
            handedOverAt: 6
          }),
          stopped('queued-b', {
            submittedAt: 4,
            handoverRecorded: true,
            ...host.sent
          })
        ])
      ).toEqual([
        user('compact'),
        { id: 'compacted', role: 'assistant' },
        user('queued-zero'),
        user('queued-a'),
        { id: 'answer', role: 'assistant' },
        user('queued-b'),
        stopRow('queued-b')
      ])
    }
  )

  /** While the first queued send’s turn streams, Stop takes back the second, which was never handed over. */
  function streamingTurnThenStop() {
    const compactTurn = 'compact-turn'
    const before = [
      sent('compact', '/compact'),
      entry(compactTurn, {
        kind: 'turn',
        turnId: compactTurn,
        state: 'completed',
        userItemId: agentJournalSubmissionKey('compact')
      }),
      sent('queued-second', 'queued second'),
      said('compacted', 'Context compacted', compactTurn),
      sent('queued-first', 'queued first'),
      entry('turn-2', {
        kind: 'turn',
        turnId: 'turn-2',
        state: 'interrupted',
        outcome: 'cancellation',
        userItemId: agentJournalSubmissionKey('queued-first')
      }),
      said('working', 'working on the first', 'turn-2')
    ]
    // The row that took the second back: a dispatch row, so no item sits on it.
    sequence += 1
    const takenBackAt = sequence
    const after = [
      entry(
        'stop:turn-2',
        { kind: 'status', text: 'Cancellation requested.' },
        { kind: 'turn', turnItemId: 'turn-2' }
      )
    ]
    return { items: [...before, ...after], takenBackAt }
  }

  it.each(HOSTS)(
    "stays below the earlier send's whole exchange when that send opened the turn, on %s",
    (_host, published) => {
      const { items, takenBackAt } = streamingTurnThenStop()

      const host = takenBackOn(published, items, 'queued-second', takenBackAt)

      expect(
        rows(host.items, [
          submission('compact', { submittedAt: 1 }),
          submission('queued-first', { submittedAt: 2, handoverRecorded: true, handedOverAt: 5 }),
          stopped('queued-second', {
            submittedAt: 3,
            handoverRecorded: true,
            ...host.sent
          })
        ])
      ).toEqual([
        user('compact'),
        { id: 'compacted', role: 'assistant' },
        user('queued-first'),
        { id: 'working', role: 'assistant' },
        { id: 'stop:turn-2', role: 'system' },
        user('queued-second'),
        stopRow('queued-second')
      ])
    }
  )

  // Tied accepts cannot order the exchanges; only the moved take-back row proves which finished before Stop.
  it('stays below a finished exchange when accept times tie, by the row the host moved', () => {
    const compactTurn = 'compact-turn'
    const items = [
      sent('compact', '/compact'),
      entry(compactTurn, {
        kind: 'turn',
        turnId: compactTurn,
        state: 'completed',
        userItemId: agentJournalSubmissionKey('compact')
      }),
      sent('queued-b', 'queued B'),
      said('compacted', 'Context compacted', compactTurn),
      sent('queued-zero', 'queued zero'),
      entry('turn-2', {
        kind: 'turn',
        turnId: 'turn-2',
        state: 'completed',
        userItemId: agentJournalSubmissionKey('queued-zero')
      }),
      said('answer', 'answer to zero', 'turn-2')
    ]

    const host = takenBackOn(true, items, 'queued-b', sequence + 1)
    expect(
      rows(host.items, [
        stopped('queued-b', { handoverRecorded: true, ...host.sent }),
        submission('compact'),
        submission('queued-zero', { handoverRecorded: true, handedOverAt: 5 })
      ])
    ).toEqual([
      user('compact'),
      { id: 'compacted', role: 'assistant' },
      user('queued-zero'),
      { id: 'answer', role: 'assistant' },
      user('queued-b'),
      stopRow('queued-b')
    ])
  })
})
