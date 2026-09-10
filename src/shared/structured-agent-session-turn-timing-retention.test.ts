import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionHistoryPage } from './agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from './structured-agent-session-reducer'
import { selectStructuredAgentSettledTurns } from './structured-agent-session-turn-timing'

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
      requestedEpoch: 'epoch',
      page: page(Array.from({ length: 64 }, (_, index) => index + first))
    })
  }
  return state
}

describe('durable turn attribution across paginated history', () => {
  it('keeps an older page duration after the recent submission budget fills', () => {
    const state = reduceStructuredAgentSession(loadedHistory(), {
      type: 'older-page',
      requestedEpoch: 'epoch',
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
      requestedEpoch: 'epoch',
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
