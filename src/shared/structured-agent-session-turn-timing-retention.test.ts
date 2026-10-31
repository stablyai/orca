import { describe, expect, it } from 'vitest'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from './structured-agent-session-reducer'
import { describeNativeChatTurnStatus } from './native-chat-turn-status'
import {
  selectStructuredAgentTurnBars,
  selectStructuredAgentSettledTurns
} from './structured-agent-session-turn-timing'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionHistoryPage } from './agent-session-wire'

function submission(index: number): AgentJournalSubmission {
  return {
    clientMessageId: `user-${index}`,
    providerItemId: `codex:thread:turn-${index}:0`,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'accepted',
    reason: null,
    submittedAt: index,
    resolvedAt: index
  }
}

function turnItems(index: number): AgentJournalRenderItem[] {
  return [
    {
      itemId: `orca:user-${index}`,
      revision: 1,
      sequence: index * 2 + 1,
      observedAt: 1_000,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
    },
    {
      itemId: `legacy:codex:session:turn-${index}`,
      revision: 2,
      sequence: index * 2 + 2,
      observedAt: 1_000,
      body: {
        kind: 'turn',
        turnId: `turn-${index}`,
        userItemId: submission(index).providerItemId!,
        state: 'completed',
        startedAt: 1_000,
        completedAt: 8_000
      }
    }
  ]
}

function page(indices: number[]): AgentSessionHistoryPage {
  return {
    sessionId: 'session',
    epoch: 'epoch',
    direction: 'tail',
    items: indices.flatMap(turnItems),
    submissions: indices.map(submission),
    removedItemIds: [],
    window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch', sequence: 1_000 } },
    hasOlder: false,
    hasNewer: false
  }
}

function loadedHistory() {
  let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'event',
    event: {
      type: 'snapshot',
      sessionId: 'session',
      fence: 1,
      page: page(Array.from({ length: 64 }, (_, index) => index + 193))
    }
  })
  for (const first of [129, 65, 1]) {
    state = reduceStructuredAgentSession(state, {
      type: 'older-page',
      requestedCursor: { epoch: 'epoch', sequence: Number.MAX_SAFE_INTEGER },
      page: page(Array.from({ length: 64 }, (_, index) => index + first))
    })
  }
  return state
}

describe('durable turn attribution across paginated history', () => {
  it('keeps an older page duration after the recent submission budget fills', () => {
    const state = reduceStructuredAgentSession(loadedHistory(), {
      type: 'older-page',
      requestedCursor: { epoch: 'epoch', sequence: Number.MAX_SAFE_INTEGER },
      page: page([0])
    })
    expect(
      selectStructuredAgentSettledTurns(state.items, state.submissions).get('orca:user-0')
    ).toEqual({ startedAt: 1_000, workedSeconds: 7 })
    expect(state.submissions).toHaveLength(257)

    const next = reduceStructuredAgentSession(state, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session',
        batch: {
          cursor: { epoch: 'epoch', sequence: 1_001 },
          items: turnItems(257),
          submissions: [submission(257)],
          removedItemIds: []
        }
      }
    })
    expect(selectStructuredAgentSettledTurns(next.items, next.submissions).size).toBe(258)
    const streamed = reduceStructuredAgentSession(next, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session',
        batch: {
          cursor: { epoch: 'epoch', sequence: 1_002 },
          items: [{ ...turnItems(257)[1]!, revision: 3 }],
          submissions: [],
          removedItemIds: []
        }
      }
    })
    expect(streamed.submissions).toBe(next.submissions)
  })

  it('drops an old alias once rewind removes its user item', () => {
    const loaded = reduceStructuredAgentSession(loadedHistory(), {
      type: 'older-page',
      requestedCursor: { epoch: 'epoch', sequence: Number.MAX_SAFE_INTEGER },
      page: page([0])
    })
    const removed = reduceStructuredAgentSession(loaded, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session',
        batch: {
          cursor: { epoch: 'epoch', sequence: 1_001 },
          items: [],
          submissions: [],
          removedItemIds: turnItems(0).map((item) => item.itemId)
        }
      }
    })
    expect(removed.submissions).toHaveLength(256)
    expect(removed.submissions.some((entry) => entry.clientMessageId === 'user-0')).toBe(false)

    const reset = reduceStructuredAgentSession(loaded, {
      type: 'event',
      event: {
        type: 'reset',
        sessionId: 'session',
        fence: 2,
        page: page([256]),
        reset: 'epoch_changed'
      }
    })
    expect(reset.submissions).toEqual([submission(256)])
    expect(selectStructuredAgentSettledTurns(reset.items, reset.submissions).size).toBe(1)
  })
})

it('uses effective cancellation for exact loaded/off-page and paged footers on desktop and mobile', () => {
  const [user, rawTurn] = turnItems(0)
  if (!user || !rawTurn || rawTurn.body.kind !== 'turn') {
    throw new Error('missing turn fixture')
  }
  const turn = {
    ...rawTurn,
    body: { ...rawTurn.body, state: 'interrupted' as const, outcome: 'cancellation' as const }
  }
  const latest = { itemId: turn.itemId, observedAt: turn.observedAt, turn: turn.body }
  for (const loaded of [[user], [user, turn]]) {
    const value = selectStructuredAgentTurnBars(
      loaded,
      [submission(0)],
      null,
      latest
    ).settledTurns.get(user.itemId)
    expect(value).toMatchObject({ workedSeconds: 7, verdict: 'cancellation' })
    expect(
      describeNativeChatTurnStatus({
        workedSeconds: value?.workedSeconds,
        verdict: value?.verdict,
        elapsedSeconds: 0
      })
    ).toEqual({ key: 'interruptedAfter', duration: '7s' })
  }
  expect(
    selectStructuredAgentTurnBars(turnItems(1), [submission(0)], null, latest).settledTurns.has(
      user.itemId
    )
  ).toBe(false)
  // A loaded provider result is authoritative over a stale off-page summary.
  expect(
    selectStructuredAgentTurnBars([user, rawTurn], [submission(0)], null, latest).settledTurns.get(
      user.itemId
    )?.verdict
  ).not.toBe('cancellation')
})
