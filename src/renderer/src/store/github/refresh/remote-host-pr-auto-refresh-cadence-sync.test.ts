import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPRAutoRefreshCadencesForTests,
  getPRAutoRefreshCadenceForHost
} from '../../../../../shared/review-refresh-policy'
import type { AppState } from '../../types'

const regained = vi.hoisted(() => ({ listeners: new Map<string, () => void>() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/hosts/connections/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (environmentId: string, listener: () => void) => {
    regained.listeners.set(environmentId, listener)
    return () => regained.listeners.delete(environmentId)
  }
}))

import {
  installRemoteHostPRAutoRefreshCadenceSync,
  readHostPRAutoRefreshCadence
} from './remote-host-pr-auto-refresh-cadence-sync'

type State = Pick<AppState, 'runtimeEnvironments' | 'runtimeStatusByEnvironmentId'>

function store(initial: State) {
  let state = initial
  const listeners = new Set<(state: AppState, previous: AppState) => void>()
  return {
    getState: () => state,
    subscribe: (listener: (state: AppState, previous: AppState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next: Partial<State>) => {
      const previous = state
      state = { ...state, ...next }
      for (const listener of listeners) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sync reads only the two fields this store carries.
        listener(state as AppState, previous as AppState)
      }
    }
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields runtimeHostContactForEntry reads for a live verdict.
const live = { verified: true, status: { runtimeId: 'r' } } as never
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
function environment(id: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sync reads only `id` of an environment.
  return { id, name: id } as AppState['runtimeEnvironments'][number]
}

describe('remote host PR auto-refresh cadence sync', () => {
  afterEach(() => {
    _resetPRAutoRefreshCadencesForTests()
    regained.listeners.clear()
  })

  it('reads a live host’s setting when it appears, again on regained contact, and forgets an unpaired host', async () => {
    const settings = new Map([['env-1', 'minimal']])
    const reader = vi.fn(async (id: string) => ({ prAutoRefresh: settings.get(id) }))
    const host = store({
      runtimeEnvironments: [environment('env-1')],
      runtimeStatusByEnvironmentId: new Map([['env-1', live]])
    })
    const stop = installRemoteHostPRAutoRefreshCadenceSync(host, reader)
    await flush()
    expect(getPRAutoRefreshCadenceForHost('env-1')).toBe('minimal')
    expect(reader).toHaveBeenCalledTimes(1)

    settings.set('env-1', 'off')
    regained.listeners.get('env-1')?.()
    await flush()
    expect(reader).toHaveBeenCalledTimes(2)
    expect(getPRAutoRefreshCadenceForHost('env-1')).toBe('off')

    host.set({ runtimeEnvironments: [] })
    expect(getPRAutoRefreshCadenceForHost('env-1')).toBe('default')
    expect(regained.listeners.has('env-1')).toBe(false)
    stop()
  })

  it('does not ask a host it has no contact with', async () => {
    const reader = vi.fn(async () => ({ prAutoRefresh: 'off' }))
    const host = store({
      runtimeEnvironments: [environment('env-2')],
      runtimeStatusByEnvironmentId: new Map()
    })
    const stop = installRemoteHostPRAutoRefreshCadenceSync(host, reader)
    await flush()
    expect(reader).not.toHaveBeenCalled()
    expect(getPRAutoRefreshCadenceForHost('env-2')).toBe('default')
    stop()
  })

  it('keeps the last known value when a read fails and dedupes concurrent reads', async () => {
    let calls = 0
    const reader = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return { prAutoRefresh: 'reduced' }
      }
      throw new Error('offline')
    })
    await readHostPRAutoRefreshCadence('env-3', reader)
    expect(getPRAutoRefreshCadenceForHost('env-3')).toBe('reduced')
    await Promise.all([
      readHostPRAutoRefreshCadence('env-3', reader),
      readHostPRAutoRefreshCadence('env-3', reader)
    ])
    expect(calls).toBe(2)
    expect(getPRAutoRefreshCadenceForHost('env-3')).toBe('reduced')
  })
})
