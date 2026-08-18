import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from './structured-agent-session-reducer'

function item(id: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: id }] }
  }
}

function submission(index: number) {
  return {
    clientMessageId: `client-${index}`,
    fence: 1,
    payloadFingerprint: `fingerprint-${index}`,
    dispatchState: 'accepted' as const,
    providerItemId: `provider-${index}`,
    reason: null,
    submittedAt: index,
    resolvedAt: index
  }
}

describe('structured agent session reducer', () => {
  it('does not offer older history after receiving a full snapshot', () => {
    const restored = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        snapshot: {
          sessionId: 'session-a',
          cursor: { epoch: 'epoch-a', sequence: 84 },
          items: Array.from({ length: 84 }, (_, index) => item(`item-${index}`, index + 1)),
          submissions: []
        }
      }
    })

    expect(restored.items).toHaveLength(84)
    expect(restored.hasOlder).toBe(false)
  })

  it('does not let a stale focus refresh replace newer streamed state', () => {
    const streamed = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        snapshot: {
          sessionId: 'session-a',
          cursor: { epoch: 'epoch-a', sequence: 50 },
          items: [item('streamed', 50)],
          submissions: []
        }
      }
    })
    const afterRefresh = reduceStructuredAgentSession(streamed, {
      type: 'tail-page',
      page: {
        sessionId: 'session-a',
        epoch: 'epoch-a',
        direction: 'tail',
        items: [item('stale', 40)],
        removedItemIds: [],
        submissions: [],
        window: {
          oldest: { epoch: 'epoch-a', sequence: 40 },
          newest: { epoch: 'epoch-a', sequence: 40 },
          nextCursor: { epoch: 'epoch-a', sequence: 40 }
        },
        liveCursor: { epoch: 'epoch-a', sequence: 40 },
        hasOlder: true,
        hasNewer: false
      }
    })

    expect(afterRefresh).toBe(streamed)
  })

  it('keeps paged-in older items when a focus refresh carries nothing new', () => {
    const snapshot = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        snapshot: {
          sessionId: 'session-a',
          cursor: { epoch: 'epoch-a', sequence: 50 },
          items: [item('newest', 50)],
          submissions: []
        }
      }
    })
    const withOlder = reduceStructuredAgentSession(snapshot, {
      type: 'older-page',
      requestedEpoch: 'epoch-a',
      page: {
        sessionId: 'session-a',
        epoch: 'epoch-a',
        direction: 'before',
        items: [item('older', 10)],
        removedItemIds: [],
        submissions: [],
        window: {
          oldest: { epoch: 'epoch-a', sequence: 10 },
          newest: { epoch: 'epoch-a', sequence: 10 },
          nextCursor: { epoch: 'epoch-a', sequence: 10 }
        },
        hasOlder: false,
        hasNewer: true
      }
    })
    const afterRefresh = reduceStructuredAgentSession(withOlder, {
      type: 'tail-page',
      page: {
        sessionId: 'session-a',
        epoch: 'epoch-a',
        direction: 'tail',
        items: [item('newest', 50)],
        removedItemIds: [],
        submissions: [],
        window: {
          oldest: { epoch: 'epoch-a', sequence: 50 },
          newest: { epoch: 'epoch-a', sequence: 50 },
          nextCursor: { epoch: 'epoch-a', sequence: 50 }
        },
        liveCursor: { epoch: 'epoch-a', sequence: 50 },
        hasOlder: true,
        hasNewer: false
      }
    })

    expect(afterRefresh).toBe(withOlder)
    expect(afterRefresh.items.map((entry) => entry.itemId)).toEqual(['older', 'newest'])
  })

  it('keeps rapid-send submissions when a newer tail refresh contains only the last one', () => {
    const initial = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        snapshot: {
          sessionId: 'session-a',
          cursor: { epoch: 'epoch-a', sequence: 10 },
          items: [item('first', 10)],
          submissions: Array.from({ length: 8 }, (_, index) => submission(index))
        }
      }
    })
    const refreshed = reduceStructuredAgentSession(initial, {
      type: 'tail-page',
      page: {
        sessionId: 'session-a',
        epoch: 'epoch-a',
        direction: 'tail',
        items: [item('latest', 11)],
        removedItemIds: [],
        submissions: [submission(7)],
        window: {
          oldest: { epoch: 'epoch-a', sequence: 11 },
          newest: { epoch: 'epoch-a', sequence: 11 },
          nextCursor: { epoch: 'epoch-a', sequence: 11 }
        },
        liveCursor: { epoch: 'epoch-a', sequence: 11 },
        hasOlder: true,
        hasNewer: false
      }
    })

    expect(refreshed.submissions.map((entry) => entry.clientMessageId)).toEqual(
      Array.from({ length: 8 }, (_, index) => `client-${index}`)
    )
  })

  it('bounds retained submission identities across repeated tail refreshes', () => {
    let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        snapshot: {
          sessionId: 'session-a',
          cursor: { epoch: 'epoch-a', sequence: 1 },
          items: [item('first', 1)],
          submissions: []
        }
      }
    })

    for (let index = 0; index < 300; index += 1) {
      state = reduceStructuredAgentSession(state, {
        type: 'tail-page',
        page: {
          sessionId: 'session-a',
          epoch: 'epoch-a',
          direction: 'tail',
          items: [item(`item-${index}`, index + 2)],
          removedItemIds: [],
          submissions: [submission(index)],
          window: {
            oldest: { epoch: 'epoch-a', sequence: index + 2 },
            newest: { epoch: 'epoch-a', sequence: index + 2 },
            nextCursor: { epoch: 'epoch-a', sequence: index + 2 }
          },
          liveCursor: { epoch: 'epoch-a', sequence: index + 2 },
          hasOlder: true,
          hasNewer: false
        }
      })
    }

    expect(state.submissions).toHaveLength(256)
    expect(state.submissions[0]?.clientMessageId).toBe('client-44')
    expect(state.submissions.at(-1)?.clientMessageId).toBe('client-299')
  })
})
