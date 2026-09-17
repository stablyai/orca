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
  it('advances the option revision without replacing transcript items', () => {
    const initial = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: hydrationPage([item('message', 1)])
      }
    })
    const updated = reduceStructuredAgentSession(initial, {
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
        optionsChanged: true
      }
    })

    expect(updated.optionsRevision).toBe(1)
    expect(updated.items).toBe(initial.items)
  })

  it('applies an additive targeted-stop capability update without journal churn', () => {
    const backgroundTasks = {
      state: 'monitoring' as const,
      tasks: [{ id: 'task-1', kind: 'agent' as const }]
    }
    const initial = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: { ...hydrationPage([]), backgroundTasks }
      }
    })
    const updated = reduceStructuredAgentSession(initial, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: { epoch: 'epoch-a', sequence: 0 },
          items: [],
          removedItemIds: [],
          submissions: []
        },
        backgroundTasks: { ...backgroundTasks, supportsTaskStop: true }
      }
    })

    expect(updated.backgroundTasks).toEqual({ ...backgroundTasks, supportsTaskStop: true })
    expect(updated.items).toBe(initial.items)
  })

  it("republishes when only a row's stoppability changes", () => {
    // A row losing its stop is the whole difference between an honest control
    // and a dead one, so it must not be dropped as an equal state.
    const backgroundTasks = {
      state: 'monitoring' as const,
      supportsTaskStop: true,
      tasks: [{ id: 'task-1', kind: 'agent' as const }]
    }
    const initial = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: { ...hydrationPage([]), backgroundTasks }
      }
    })
    const updated = reduceStructuredAgentSession(initial, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: { epoch: 'epoch-a', sequence: 0 },
          items: [],
          removedItemIds: [],
          submissions: []
        },
        backgroundTasks: {
          ...backgroundTasks,
          tasks: [{ id: 'task-1', kind: 'agent' as const, stoppable: false }]
        }
      }
    })

    expect(updated.backgroundTasks?.tasks).toEqual([
      { id: 'task-1', kind: 'agent', stoppable: false }
    ])
  })

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

  it('applies a publication whose only change is one task state or settled roster', () => {
    const monitoring = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: hydrationPage([item('message', 1)]),
        backgroundTasks: {
          state: 'monitoring',
          tasks: [
            { id: 'task-1', kind: 'agent', name: 'deep_review', state: 'working', startedAt: 100 }
          ]
        }
      }
    })
    const batch = (backgroundTasks: NonNullable<typeof monitoring.backgroundTasks>) =>
      reduceStructuredAgentSession(monitoring, {
        type: 'event',
        event: {
          type: 'batch',
          sessionId: 'session-a',
          batch: { cursor: monitoring.cursor!, items: [], removedItemIds: [], submissions: [] },
          fence: 1,
          backgroundTasks
        }
      })

    const stateOnly = batch({
      state: 'monitoring',
      tasks: [
        { id: 'task-1', kind: 'agent', name: 'deep_review', state: 'waiting', startedAt: 100 }
      ]
    })
    expect(stateOnly).not.toBe(monitoring)
    expect(stateOnly.backgroundTasks?.tasks?.[0]?.state).toBe('waiting')

    const settledOnly = batch({
      state: 'monitoring',
      tasks: [
        { id: 'task-1', kind: 'agent', name: 'deep_review', state: 'working', startedAt: 100 }
      ],
      settledTasks: [{ id: 'task-2', kind: 'agent', state: 'done', startedAt: 50 }]
    })
    expect(settledOnly).not.toBe(monitoring)
    expect(settledOnly.backgroundTasks?.settledTasks).toHaveLength(1)

    const tokensOnly = batch({
      state: 'monitoring',
      tasks: [
        {
          id: 'task-1',
          kind: 'agent',
          name: 'deep_review',
          state: 'working',
          startedAt: 100,
          totalTokens: 18_130
        }
      ]
    })
    expect(tokensOnly.backgroundTasks?.tasks?.[0]?.totalTokens).toBe(18_130)

    const unchanged = batch({
      state: 'monitoring',
      tasks: [
        { id: 'task-1', kind: 'agent', name: 'deep_review', state: 'working', startedAt: 100 }
      ]
    })
    expect(unchanged).toBe(monitoring)
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

  it('projects ephemeral activity without changing transcript identity and clears it', () => {
    const initial = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 'session-a',
        fence: 1,
        page: hydrationPage([item('message', 1)])
      }
    })
    const active = reduceStructuredAgentSession(initial, {
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
        activity: { turnId: 'turn-1', text: 'Checking the renderer' }
      }
    })

    expect(active.activity).toEqual({ turnId: 'turn-1', text: 'Checking the renderer' })
    expect(active.items).toBe(initial.items)

    const cleared = reduceStructuredAgentSession(active, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: active.cursor!,
          items: [],
          removedItemIds: [],
          submissions: []
        },
        activity: null
      }
    })

    expect(cleared.activity).toBeNull()
    expect(cleared.items).toBe(active.items)
  })

  it('records the host clock from frames that carry it and keeps it otherwise', () => {
    const snapshot = reduceStructuredAgentSession(
      EMPTY_STRUCTURED_AGENT_SESSION,
      {
        type: 'event',
        event: {
          type: 'snapshot',
          sessionId: 'session-a',
          fence: 1,
          page: hydrationPage([item('first', 1)]),
          hostNow: 5_000
        }
      },
      9_000
    )
    expect(snapshot.hostClock).toEqual({ hostNow: 5_000, receivedAt: 9_000 })

    const batch = reduceStructuredAgentSession(
      snapshot,
      {
        type: 'event',
        event: {
          type: 'batch',
          sessionId: 'session-a',
          fence: 1,
          hostNow: 5_400,
          batch: {
            cursor: { epoch: 'epoch-a', sequence: 2 },
            items: [item('second', 2)],
            removedItemIds: [],
            submissions: []
          }
        }
      },
      9_400
    )
    expect(batch.hostClock).toEqual({ hostNow: 5_400, receivedAt: 9_400 })

    // An older host stamps nothing; the last sample stays usable.
    const unstamped = reduceStructuredAgentSession(
      batch,
      {
        type: 'event',
        event: {
          type: 'batch',
          sessionId: 'session-a',
          fence: 1,
          batch: {
            cursor: { epoch: 'epoch-a', sequence: 3 },
            items: [item('third', 3)],
            removedItemIds: [],
            submissions: []
          }
        }
      },
      9_800
    )
    expect(unstamped.hostClock).toEqual({ hostNow: 5_400, receivedAt: 9_400 })
  })
})

it('applies catalog-only checkpoints without replacing transcript or submission state', () => {
  const state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'event',
    event: {
      type: 'snapshot',
      sessionId: 'session-a',
      fence: 1,
      page: hydrationPage([item('one', 1)], [submission(1)]),
      commands: []
    }
  })
  const event = {
    type: 'batch' as const,
    sessionId: 'session-a',
    fence: 1,
    commands: [{ name: 'loaded', kind: 'skill' as const }],
    batch: { cursor: state.cursor!, items: [], removedItemIds: [], submissions: [] }
  }
  const updated = reduceStructuredAgentSession(state, { type: 'event', event })
  expect(updated.commands).toEqual(event.commands)
  expect(updated.items).toBe(state.items)
  expect(updated.submissions).toBe(state.submissions)
  expect(updated.cursor).toBe(state.cursor)
  expect(reduceStructuredAgentSession(updated, { type: 'event', event })).toBe(updated)
  const { commands: _commands, ...oldEvent } = event
  expect(reduceStructuredAgentSession(updated, { type: 'event', event: oldEvent })).toBe(updated)
})
