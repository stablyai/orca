import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { createSessionWriteSubscriber } from './session-write-subscriber'
import { SESSION_RELEVANT_FIELDS } from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'

/**
 * Why a hand-built store: the subscriber allocates a 35-field snapshot plus a changed-field array
 * on every fire that reaches its body, and both are invisible from outside. Driving it through an
 * injected store lets `Array.prototype.filter` stand in as the allocation counter — the changed
 * list is built 1:1 with the snapshot, in the same block, so one count measures both.
 */
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
    persist: (payload) => persisted.push(payload)
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
  it('allocates nothing for store writes that touch no session field', () => {
    const harness = createHarness()
    try {
      // Prime `prev` on the first fire.
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
      // Before: one changed-field array (and one 35-field snapshot) per write.
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
    let gateOpen = false
    const dispose = createSessionWriteSubscriber({
      store: {
        subscribe: (listener) => {
          listeners.push(listener)
          return () => {}
        },
        getState: () => state
      },
      persist: (payload) => persisted.push(payload),
      shouldSchedulePersist: () => gateOpen,
      subscribeToPersistGateOpen: () => () => {}
    })
    const write = (patch: Partial<AppState>): void => {
      state = { ...state, ...patch } as AppState
      for (const listener of listeners.slice()) {
        listener(state)
      }
    }
    try {
      // A real session change lands while the gate is closed, so the write is owed but deferred.
      write({ activeTabId: 'tab-1' })
      vi.advanceTimersByTime(500)
      expect(persisted).toHaveLength(0)

      // An unrelated write with the gate open must re-arm it even though nothing session-relevant
      // moved — the identity-scan fast path must not swallow this wake-up.
      gateOpen = true
      write({ agentStatusByPaneKey: { a: {} } as never })
      vi.advanceTimersByTime(500)
      expect(persisted).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('gates on a strict superset of the fields the patch builder reads', () => {
    // A gate that misses a projection input persists stale state, so this is a correctness lock,
    // not a perf one. Record what the builder actually touches rather than trusting the types.
    const read = new Set<string>()
    const snapshot = new Proxy(makeSessionState() as unknown as Record<string, unknown>, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          read.add(property)
        }
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
