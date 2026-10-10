import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionHistoryPage, AgentSessionLatestTurn } from './agent-session-wire'
import { runningStructuredAgentSessionTurnId } from './structured-agent-session-live-turn'
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
  it("orders one journal write's items by their place in it, whatever order they arrive in", () => {
    const at = (id: string, sequence: number, sequenceIndex: number): AgentJournalRenderItem => ({
      ...item(id, sequence),
      ...(sequenceIndex > 0 ? { sequenceIndex } : {})
    })
    const paged = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: hydrationPage([
        item('before', 4),
        at('third', 5, 2),
        at('first', 5, 0),
        at('second', 5, 1)
      ])
    })
    expect(paged.items.map(({ itemId }) => itemId)).toEqual(['before', 'first', 'second', 'third'])
    const live = reduceStructuredAgentSession(paged, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: { epoch: 'epoch-a', sequence: 6 },
          items: [at('next-b', 6, 1), at('next-a', 6, 0)],
          removedItemIds: [],
          submissions: []
        }
      }
    })
    expect(live.items.map(({ itemId }) => itemId).slice(-2)).toEqual(['next-a', 'next-b'])
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

  it('decodes child rows once as they arrive: a malformed row is dropped, and a repeat keeps identity', () => {
    const view = {
      id: 'child-1',
      providerId: 'task-1',
      kind: 'agent',
      state: 'working',
      membership: 'live',
      firstObservedAt: 1,
      observedAt: 2,
      stoppable: true,
      invocation: { invocationId: 'spawn-1', generation: 1 }
    }
    // A row a newer host shapes differently: no invocation, which equality would dereference.
    const { invocation: _invocation, ...malformed } = { ...view, id: 'child-2' }
    const roster = { state: 'monitoring', tasks: [], children: [view, malformed] }
    const batch = (backgroundTasks: unknown, sequence: number) =>
      reduceStructuredAgentSession(state, {
        type: 'event',
        event: {
          type: 'batch',
          sessionId: 'session-a',
          batch: {
            cursor: { epoch: 'epoch-a', sequence },
            items: sequence > 0 ? [item(`item-${sequence}`, sequence)] : [],
            removedItemIds: [],
            submissions: []
          },
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a wire frame as it arrives, before the client decodes it.
          backgroundTasks: structuredClone(backgroundTasks) as never
        }
      })
    let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: { type: 'snapshot', sessionId: 'session-a', fence: 1, page: hydrationPage([]) }
    })
    state = batch(roster, 0)
    expect(state.backgroundTasks?.children).toEqual([view])
    const kept = state.backgroundTasks
    // The same roster again, beside a journal change: the roster keeps its identity.
    state = batch(roster, 1)
    expect(state.items.map(({ itemId }) => itemId)).toEqual(['item-1'])
    expect(state.backgroundTasks).toBe(kept)
  })

  it("keeps a failed read's refusal beside its text until the read recovers", () => {
    const refusal = {
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalCorrupt' }
    } as const
    const failed = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'error',
      message: 'agent_session_journal_unreadable',
      refusal
    })
    expect(failed).toMatchObject({ status: 'error', readRefusal: refusal })

    expect(reduceStructuredAgentSession(failed, { type: 'loading' }).readRefusal).toBeUndefined()
    const live = reduceStructuredAgentSession(
      reduceStructuredAgentSession(failed, {
        type: 'history-page',
        page: hydrationPage([item('a', 1)])
      }),
      { type: 'error', message: 'transport died' }
    )
    expect(live.readRefusal).toBeUndefined()
    const recovered = reduceStructuredAgentSession(
      { ...live, readRefusal: refusal },
      {
        type: 'event',
        event: {
          type: 'batch',
          sessionId: 'session-a',
          batch: {
            cursor: { epoch: 'epoch-a', sequence: 2 },
            items: [item('b', 2)],
            removedItemIds: [],
            submissions: []
          }
        }
      }
    )
    expect(recovered).toMatchObject({ status: 'ready', error: undefined, readRefusal: undefined })
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

  // An older host omits the roster only when its records hold no running child; a pane resuming
  // from its cursor must not keep the one it held while away (#24227).
  it("drops the held roster on a resumed subscription's first batch that omits it", () => {
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
    const batch = {
      type: 'batch' as const,
      sessionId: 'session-a',
      batch: { cursor: monitoring.cursor!, items: [], removedItemIds: [], submissions: [] },
      fence: 1
    }

    expect(reduceStructuredAgentSession(monitoring, { type: 'event', event: batch })).toBe(
      monitoring
    )
    const resumed = reduceStructuredAgentSession(monitoring, {
      type: 'event',
      event: batch,
      opensSubscription: true
    })
    expect(resumed.backgroundTasks).toBeUndefined()
    expect(resumed.items).toBe(monitoring.items)
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

  describe("the host's newest turn record", () => {
    const turnRow = (state: 'running' | 'completed'): AgentJournalRenderItem => ({
      itemId: 'turn-record',
      revision: state === 'running' ? 1 : 2,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'turn', turnId: 'turn-1', state }
    })
    const hostTurn = (state: 'running' | 'completed'): AgentSessionLatestTurn => ({
      itemId: 'turn-record',
      observedAt: 1,
      turn: { turnId: 'turn-1', state }
    })
    const opened = () =>
      reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
        type: 'event',
        event: {
          type: 'snapshot',
          sessionId: 'session-a',
          fence: 1,
          page: { ...hydrationPage([turnRow('running')]), latestTurn: hostTurn('running') }
        }
      })
    const batch = (
      state: ReturnType<typeof opened>,
      items: AgentJournalRenderItem[],
      latestTurn?: AgentSessionLatestTurn | null
    ) =>
      reduceStructuredAgentSession(state, {
        type: 'event',
        event: {
          type: 'batch',
          sessionId: 'session-a',
          batch: {
            cursor: { epoch: 'epoch-a', sequence: state.cursor!.sequence + items.length },
            items,
            removedItemIds: [],
            submissions: []
          },
          activity: { turnId: 'turn-1', text: 'Reading' },
          ...(latestTurn !== undefined ? { latestTurn } : {})
        }
      })

    it('keeps it across a frame that carries no rows, and takes the next one rows carry', () => {
      const quiet = batch(opened(), [])
      expect(quiet.latestTurn).toEqual(hostTurn('running'))
      const ended = batch(quiet, [turnRow('completed')], hostTurn('completed'))
      expect(ended.latestTurn).toEqual(hostTurn('completed'))
      expect(runningStructuredAgentSessionTurnId(ended)).toBeNull()
    })

    it('falls back to the loaded rows when rows arrive without it, as from an older host', () => {
      // A cursor resume against a downgraded host: its rows end the turn but restate nothing.
      const downgraded = batch(opened(), [turnRow('completed')])
      expect(downgraded.latestTurn).toBeUndefined()
      expect(runningStructuredAgentSessionTurnId(downgraded)).toBeNull()
    })
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
