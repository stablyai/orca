import { expect, it } from 'vitest'
import type { AgentSessionHistoryPage, AgentSessionLatestTurn } from '../../agent-session-wire'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../journal/agent-session-journal-types'
import { structuredAgentSessionSendingItemIds } from '../structured-agent-session-sending'
import { createStructuredAgentTurnBarsSelector } from '../structured-agent-session-turn-timing'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from './structured-agent-session-reducer'

const EPOCH = 'receipt-epoch'
const SEND: AgentJournalSubmission = {
  clientMessageId: 'opener',
  fence: 2,
  payloadFingerprint: 'test',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  submittedAt: 1000,
  resolvedAt: null,
  handedOverAt: 1400
}

function page(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]) {
  const cursor = (item: AgentJournalRenderItem | undefined) =>
    item ? { epoch: EPOCH, sequence: item.sequence } : null
  const oldest = cursor(items[0])
  const newest = cursor(items.at(-1))
  return {
    sessionId: 'chat',
    epoch: EPOCH,
    direction: 'before',
    items,
    removedItemIds: [],
    submissions,
    window: { oldest, newest, nextCursor: newest ?? { epoch: EPOCH, sequence: 0 } },
    hasOlder: true,
    hasNewer: false
  } satisfies AgentSessionHistoryPage
}

function batch(
  state: StructuredAgentSessionState,
  sequence: number,
  submissions: AgentJournalSubmission[],
  items: AgentJournalRenderItem[] = [],
  latestTurn?: AgentSessionLatestTurn
) {
  return reduceStructuredAgentSession(
    state,
    {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'chat',
        latestTurn,
        batch: { cursor: { epoch: EPOCH, sequence }, items, removedItemIds: [], submissions }
      }
    },
    5000
  )
}

// PR #45057: a receipt used to reread every loaded item in retention and again in turn timing.
it.each([4096, 40960])('keeps receipt work off all %i loaded rows', (count) => {
  let reads = 0
  const items = Array.from({ length: count }, (_, index): AgentJournalRenderItem => {
    const role = index === count - 1 ? 'user' : 'assistant'
    return {
      itemId: role === 'user' ? 'orca:opener' : `history:${index}`,
      revision: 0,
      sequence: index + 2,
      observedAt: 1000,
      get body(): AgentJournalRenderItem['body'] {
        reads += 1
        return { kind: 'message', role, blocks: [] }
      }
    }
  })
  const initial = reduceStructuredAgentSession(
    EMPTY_STRUCTURED_AGENT_SESSION,
    { type: 'history-page', page: page(items, [SEND]) },
    1500
  )
  const selectTurnBars = createStructuredAgentTurnBarsSelector()
  const timingOf = (state: StructuredAgentSessionState, turnId: string | null = null) =>
    selectTurnBars(state.items, state.submissions, turnId, state.latestTurn)
  const before = timingOf(initial)
  expect(structuredAgentSessionSendingItemIds([], initial.submissions)).toEqual(
    new Set(['orca:opener'])
  )

  reads = 0
  const stampedSend = { ...SEND, writtenAt: 2000 }
  const stamped = batch(initial, count + 2, [stampedSend])
  const retentionReads = reads
  reads = 0
  const stampedTiming = timingOf(stamped)
  const timingReads = reads
  expect({ retentionReads, timingReads }).toEqual({ retentionReads: 0, timingReads: 0 })
  expect(stamped.items).toBe(initial.items)
  expect(stamped.submissions).toEqual([stampedSend])
  expect(stampedTiming).toBe(before)
  expect(stamped.hasOlder).toBe(true)
  expect(structuredAgentSessionSendingItemIds([], stamped.submissions)).toEqual(new Set())

  const turn = {
    itemId: 'turn-lifecycle:run',
    revision: 0,
    sequence: count + 3,
    observedAt: 3000,
    body: {
      kind: 'turn',
      turnId: 'run',
      state: 'running',
      startedAt: 3000,
      userItemId: 'orca:opener'
    }
  } satisfies AgentJournalRenderItem
  const { kind: _kind, ...turnSummary } = turn.body
  const latestTurn = { itemId: turn.itemId, observedAt: turn.observedAt, turn: turnSummary }
  const steer = { ...SEND, clientMessageId: 'steer', submittedAt: 3200, handedOverAt: 3300 }
  const started = batch(stamped, count + 3, [steer], [turn], latestTurn)
  const running = timingOf(started, 'run')
  expect(running.runningTiming?.startedAt).toBe(3000)

  reads = 0
  const restamped = batch(started, count + 4, [{ ...steer, writtenAt: 3500 }], [], {
    ...latestTurn,
    turn: { ...latestTurn.turn }
  })
  expect(timingOf(restamped, 'run')).toBe(running)
  expect(reads).toBe(0)

  const completed = batch(
    restamped,
    count + 5,
    [],
    [
      {
        ...turn,
        revision: 1,
        body: { ...turn.body, state: 'completed', completedAt: 5000 }
      }
    ]
  )
  const settled = timingOf(completed)
  expect(settled.runningTiming).toBeNull()
  expect(settled.settledTurns.get('orca:opener')?.workedSeconds).toBe(2)

  const rejected = batch(completed, count + 6, [
    { ...stampedSend, dispatchState: 'rejected', resolvedAt: 5000 }
  ])
  expect(timingOf(rejected).settledTurns.get('orca:opener')).toBeNull()

  const older: AgentJournalRenderItem = {
    itemId: 'turn-lifecycle:older',
    revision: 0,
    sequence: 1,
    observedAt: 100,
    body: { kind: 'turn', turnId: 'older', state: 'completed', startedAt: 100, completedAt: 1100 }
  }
  const paged = reduceStructuredAgentSession(
    rejected,
    {
      type: 'older-page',
      requestedCursor: { epoch: EPOCH, sequence: 2 },
      page: page([older], [])
    },
    5000
  )
  expect(timingOf(paged).settledTurns.get(older.itemId)?.workedSeconds).toBe(1)
  expect(timingOf(EMPTY_STRUCTURED_AGENT_SESSION).settledTurns.size).toBe(0)
})
