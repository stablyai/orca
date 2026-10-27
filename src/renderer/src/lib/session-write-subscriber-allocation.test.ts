import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { createSessionWriteSubscriber } from './session-write-subscriber'
import { SESSION_RELEVANT_FIELDS } from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'

/** Inject a store to count Array.filter allocations: each changed-field list shares the block allocating its 35-field snapshot, so one count observes both costs. */
function makeSessionState(overrides: Partial<AppState> = {}): AppState {
  const base: Record<string, unknown> = {
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    // Non-session state the subscriber must ignore.
    agentStatusByPaneKey: {},
    runtimePaneTitlesByTabId: {}
  }
  const arrayFields = new Set<string>([
    'repos',
    'openFiles',
    'browserUrlHistory',
    'workspaceDocHistory'
  ])
  const mapFields = new Set<string>(['sshConnectionStates'])
  for (const key of SESSION_RELEVANT_FIELDS) {
    base[key] = arrayFields.has(key) ? [] : mapFields.has(key) ? new Map() : {}
  }
  base.activeRepoId = null
  base.activeWorkspaceKey = null
  base.activeWorktreeId = null
  base.activeTabId = null
  base.activeWorkspaceExecutionHostId = null
  return { ...base, ...overrides } as AppState
}

function createHarness() {
  let state = makeSessionState()
  const listeners: ((next: AppState) => void)[] = []
  const persisted: unknown[] = []
  const dispose = createSessionWriteSubscriber({
    store: {
      subscribe: (listener) => {
        listeners.push(listener)
        return () => {
          listeners.splice(listeners.indexOf(listener), 1)
        }
      },
      getState: () => state
    },
    persist: (payload) => {
      persisted.push(payload)
    }
  })
  return {
    dispose,
    persisted,
    write(mutate?: (previous: AppState) => Partial<AppState>) {
      state = { ...state, ...mutate?.(state) } as AppState
      for (const listener of listeners.slice()) {
        listener(state)
      }
    }
  }
}

function countFilterCalls<T>(run: () => T): number {
  const original = Array.prototype.filter
  let calls = 0
  const spy = vi.spyOn(Array.prototype, 'filter').mockImplementation(function filterCounting(
    this: unknown[],
    ...args: never[]
  ) {
    calls += 1
    return (original as (...a: never[]) => unknown[]).apply(this, args)
  } as typeof Array.prototype.filter)
  try {
    run()
    return calls
  } finally {
    spy.mockRestore()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('session write subscriber allocation', () => {
  it.each(['tabsByWorktree', 'unifiedTabsByWorktree'] as const)(
    'remembers an equivalent %s source before unrelated writes',
    (field) => {
      const harness = createHarness()
      try {
        harness.write(() => ({ [field]: { 'wt-1': [] } }))
        vi.advanceTimersByTime(500)
        harness.persisted.length = 0

        harness.write(() => ({ [field]: { 'wt-1': [] } }))
        const calls = countFilterCalls(() => {
          for (let write = 0; write < 200; write += 1) {
            harness.write(() => ({ runtimePaneTitlesByTabId: {} }))
          }
        })
        expect(calls).toBe(0)
        vi.advanceTimersByTime(500)
        expect(harness.persisted).toHaveLength(0)

        harness.write(() => ({ activeTabId: 'next-tab' }))
        vi.advanceTimersByTime(500)
        expect(harness.persisted).toHaveLength(1)
      } finally {
        harness.dispose()
      }
    }
  )

  it('allocates nothing for store writes that touch no session field', () => {
    const harness = createHarness()
    try {
      harness.write()
      vi.advanceTimersByTime(500)

      const writes = 200
      const calls = countFilterCalls(() => {
        for (let write = 0; write < writes; write += 1) {
          harness.write((previous) => ({
            agentStatusByPaneKey: { ...previous.agentStatusByPaneKey, [`p-${write}`]: {} } as never
          }))
        }
      })
      expect(calls).toBe(0)
    } finally {
      harness.dispose()
    }
  })

  it('still allocates and persists when a session field really changes', () => {
    const harness = createHarness()
    try {
      harness.write()
      vi.advanceTimersByTime(500)
      harness.persisted.length = 0

      const writes = 20
      const calls = countFilterCalls(() => {
        for (let write = 0; write < writes; write += 1) {
          harness.write(() => ({ activeTabId: `tab-${write}` }))
        }
      })
      expect(calls).toBe(writes)
      vi.advanceTimersByTime(500)
      expect(harness.persisted).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })

  it('still wakes a deferred write when an unrelated field changes', () => {
    let state = makeSessionState()
    const listeners: ((next: AppState) => void)[] = []
    const persisted: unknown[] = []
    let refuse = true
    const dispose = createSessionWriteSubscriber({
      store: {
        subscribe: (listener) => {
          listeners.push(listener)
          return () => {}
        },
        getState: () => state
      },
      persist: (payload) => {
        if (refuse) {
          throw new Error('write refused')
        }
        persisted.push(payload)
      }
    })
    const write = (patch: Partial<AppState>): void => {
      state = { ...state, ...patch } as AppState
      for (const listener of listeners.slice()) {
        listener(state)
      }
    }
    try {
      // A real session change whose write is refused, so the write is owed but deferred.
      write({ activeTabId: 'tab-1' })
      vi.advanceTimersByTime(500)
      expect(persisted).toHaveLength(0)

      // Unrelated writes must wake deferred persistence even when session identities are unchanged.
      refuse = false
      write({ agentStatusByPaneKey: { a: {} } as never })
      vi.advanceTimersByTime(500)
      expect(persisted).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('gates on a strict superset of the fields the patch builder reads', () => {
    // Record actual projection reads; missing one persists stale data, making this a correctness gate, not just performance.
    const read = new Set<string>()
    const snapshot = new Proxy(makeSessionState() as unknown as Record<string, unknown>, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          read.add(property)
        }
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
        return Reflect.get(target, property, receiver)
      }
    })
    buildWorkspaceSessionPatch(
      snapshot as never,
      SESSION_RELEVANT_FIELDS as unknown as Iterable<never>
    )
    const gated = new Set<string>(SESSION_RELEVANT_FIELDS)
    expect([...read].filter((field) => !gated.has(field))).toEqual([])
    expect(read.size).toBeGreaterThan(0)
  })
})
