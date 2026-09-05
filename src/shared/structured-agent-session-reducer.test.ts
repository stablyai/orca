import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionHistoryPage } from './agent-session-wire'
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

function hydrationPage(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[] = []
): AgentSessionHistoryPage {
  const oldest = items[0]?.sequence ?? 0
  const newest = items.at(-1)?.sequence ?? 0
  return {
    sessionId: 'session-a',
    epoch: 'epoch-a',
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions,
    window: {
      oldest: items[0] ? { epoch: 'epoch-a', sequence: oldest } : null,
      newest: items.at(-1) ? { epoch: 'epoch-a', sequence: newest } : null,
      nextCursor: { epoch: 'epoch-a', sequence: oldest }
    },
    liveCursor: { epoch: 'epoch-a', sequence: newest },
    hasOlder: false,
    hasNewer: false
  }
}

describe('structured agent session reducer', () => {
  it('uses the bounded hydration page pagination boundary', () => {
    const restored = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: hydrationPage(
          Array.from({ length: 84 }, (_, index) => item(`item-${index}`, index + 1))
        )
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
        page: hydrationPage([item('streamed', 50)])
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
        page: hydrationPage([item('newest', 50)])
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

  it('accepts a newer fence from an equal-cursor tail refresh', () => {
    const initial = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: hydrationPage([item('newest', 50)])
      }
    })
    const page = { ...hydrationPage([item('newest', 50)]), fence: 2 }

    const refreshed = reduceStructuredAgentSession(initial, { type: 'tail-page', page })

    expect(refreshed.fence).toBe(2)
    expect(refreshed.items).toBe(initial.items)
  })

  it('keeps rapid-send submissions when a newer tail refresh contains only the last one', () => {
    const initial = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: hydrationPage(
          [item('first', 10)],
          Array.from({ length: 8 }, (_, index) => submission(index))
        )
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
        page: hydrationPage([item('first', 1)])
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

  it('projects additive background task state without changing transcript identity', () => {
    const initial = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: hydrationPage([item('message', 1)]),
        backgroundTasks: null
      }
    })
    const monitoring = reduceStructuredAgentSession(initial, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: initial.cursor!,
          items: [],
          removedItemIds: [],
          submissions: []
        },
        fence: 1,
        backgroundTasks: { state: 'monitoring' }
      }
    })

    expect(monitoring.backgroundTasks).toEqual({ state: 'monitoring' })
    expect(monitoring.items).toBe(initial.items)
  })

  it('returns the same state for duplicate background task publications', () => {
    const monitoring = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: hydrationPage([item('message', 1)]),
        backgroundTasks: { state: 'monitoring' }
      }
    })
    const duplicate = reduceStructuredAgentSession(monitoring, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: monitoring.cursor!,
          items: [],
          removedItemIds: [],
          submissions: []
        },
        fence: 1,
        backgroundTasks: { state: 'monitoring' }
      }
    })

    expect(duplicate).toBe(monitoring)
  })

  it('applies background task roster changes without a journal update', () => {
    const monitoring = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: hydrationPage([item('message', 1)]),
        backgroundTasks: {
          state: 'monitoring',
          tasks: [{ id: 'task-1', kind: 'command', description: 'first command' }]
        }
      }
    })
    const changed = reduceStructuredAgentSession(monitoring, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: monitoring.cursor!,
          items: [],
          removedItemIds: [],
          submissions: []
        },
        fence: 1,
        backgroundTasks: {
          state: 'monitoring',
          tasks: [{ id: 'task-1', kind: 'agent', description: 'review the change' }]
        }
      }
    })

    expect(changed).not.toBe(monitoring)
    expect(changed.backgroundTasks?.tasks).toEqual([
      { id: 'task-1', kind: 'agent', description: 'review the change' }
    ])
    expect(changed.items).toBe(monitoring.items)
  })

  it('clears additive background state when a replacement snapshot omits the field', () => {
    const monitoring = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: hydrationPage([item('message', 1)]),
        backgroundTasks: { state: 'monitoring' }
      }
    })
    const withoutCapability = reduceStructuredAgentSession(monitoring, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 2,
        page: hydrationPage([item('message', 1)])
      }
    })

    expect(withoutCapability.backgroundTasks).toBeUndefined()
  })
})
