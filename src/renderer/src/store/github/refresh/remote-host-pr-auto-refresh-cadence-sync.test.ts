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
import {
  _resetHostPRAutoRefreshCadenceGenerationsForTests,
  _trackedHostPRAutoRefreshStateCountForTests,
  forgetHostPRAutoRefreshCadence,
  hostLacksPRAutoRefresh,
  rememberHostPRAutoRefreshCadence
} from './remote-host-pr-auto-refresh-cadence'

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
    _resetHostPRAutoRefreshCadenceGenerationsForTests()
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

  it('keeps the last known value when a read fails, and a change during a read is re-read once', async () => {
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
      readHostPRAutoRefreshCadence('env-3', reader),
      readHostPRAutoRefreshCadence('env-3', reader)
    ])
    // The failed read plus one trailing read for the changes reported while it was pending.
    expect(calls).toBe(3)
    expect(getPRAutoRefreshCadenceForHost('env-3')).toBe('reduced')
  })

  it('re-reads after settingsChanged arrives while an older settings snapshot is in flight', async () => {
    let finish!: (value: { prAutoRefresh: string }) => void
    let calls = 0
    const reader = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return await new Promise<{ prAutoRefresh: string }>((resolve) => {
          finish = resolve
        })
      }
      return { prAutoRefresh: 'default' }
    })
    const first = readHostPRAutoRefreshCadence('env-4', reader)
    // The host had already snapshotted Off; another client changed it and settingsChanged arrived.
    const changed = readHostPRAutoRefreshCadence('env-4', reader)
    finish({ prAutoRefresh: 'off' })
    await Promise.all([first, changed])
    expect(calls).toBe(2)
    expect(getPRAutoRefreshCadenceForHost('env-4')).toBe('default')
  })

  it('a change during a read that fails is still re-read', async () => {
    let fail!: (error: Error) => void
    let calls = 0
    const reader = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        return await new Promise<{ prAutoRefresh: string }>((_resolve, reject) => {
          fail = reject
        })
      }
      return { prAutoRefresh: 'minimal' }
    })
    const first = readHostPRAutoRefreshCadence('env-5', reader)
    const changed = readHostPRAutoRefreshCadence('env-5', reader)
    fail(new Error('timed out'))
    await Promise.all([first, changed])
    expect(getPRAutoRefreshCadenceForHost('env-5')).toBe('minimal')
  })

  it('a slow read does not revert a value the Settings control wrote meanwhile', async () => {
    let finish!: (value: { prAutoRefresh: string }) => void
    const reader = vi.fn(
      async () =>
        await new Promise<{ prAutoRefresh: string }>((resolve) => {
          finish = resolve
        })
    )
    const read = readHostPRAutoRefreshCadence('env-6', reader)
    rememberHostPRAutoRefreshCadence('env-6', 'off')
    finish({ prAutoRefresh: 'default' })
    await read
    expect(getPRAutoRefreshCadenceForHost('env-6')).toBe('off')
  })

  it('a slow read does not re-add a host that was unpaired meanwhile', async () => {
    let finish!: (value: { prAutoRefresh: string }) => void
    const reader = vi.fn(
      async () =>
        await new Promise<{ prAutoRefresh: string }>((resolve) => {
          finish = resolve
        })
    )
    rememberHostPRAutoRefreshCadence('env-7', 'minimal')
    const read = readHostPRAutoRefreshCadence('env-7', reader)
    forgetHostPRAutoRefreshCadence('env-7')
    finish({ prAutoRefresh: 'minimal' })
    await read
    expect(getPRAutoRefreshCadenceForHost('env-7')).toBe('default')
  })

  it('keeps nothing for hosts that come and go, a held changed read included, and reads a re-paired host afresh', async () => {
    const held: ((value: { prAutoRefresh: string }) => void)[] = []
    const reader = vi.fn((id: string) =>
      id === 'env-held'
        ? new Promise<{ prAutoRefresh: string }>((resolve) => held.push(resolve))
        : Promise.resolve({ prAutoRefresh: 'reduced' })
    )
    const ids = [...Array.from({ length: 20 }, (_, index) => `env-${index}`), 'env-held']
    const host = store({
      runtimeEnvironments: [...ids, 'env-stays'].map(environment),
      runtimeStatusByEnvironmentId: new Map([...ids, 'env-stays'].map((id) => [id, live]))
    })
    const stop = installRemoteHostPRAutoRefreshCadenceSync(host, reader)
    await flush()
    // The held host reports a change while its read is out, then it and the others are unpaired.
    regained.listeners.get('env-held')?.()
    host.set({ runtimeEnvironments: [environment('env-stays')] })
    expect(_trackedHostPRAutoRefreshStateCountForTests()).toBe(0)

    // Paired again before the old read answers: the old answer is dropped, a new read decides.
    host.set({ runtimeEnvironments: [environment('env-stays'), environment('env-held')] })
    held[0]({ prAutoRefresh: 'off' })
    await flush()
    expect(getPRAutoRefreshCadenceForHost('env-held')).toBe('default')
    held[1]({ prAutoRefresh: 'minimal' })
    await flush()
    expect(getPRAutoRefreshCadenceForHost('env-held')).toBe('minimal')
    expect(reader.mock.calls.filter(([id]) => id === 'env-held')).toHaveLength(2)
    expect(getPRAutoRefreshCadenceForHost('env-stays')).toBe('reduced')

    host.set({ runtimeEnvironments: [] })
    expect(_trackedHostPRAutoRefreshStateCountForTests()).toBe(0)
    expect(getPRAutoRefreshCadenceForHost('env-held')).toBe('default')
    stop()
  })

  it('marks a host that answers without the setting (an older Orca) as lacking it, scheduled as Default', async () => {
    // An older host's settings.get has no prAutoRefresh key at all.
    const answers: { prAutoRefresh?: string }[] = [{}, { prAutoRefresh: 'reduced' }]
    const reader = vi.fn(async () => answers.shift() ?? {})
    await readHostPRAutoRefreshCadence('env-old', reader)
    expect(hostLacksPRAutoRefresh('env-old')).toBe(true)
    expect(getPRAutoRefreshCadenceForHost('env-old')).toBe('default')

    // The host was updated and answers with the setting on the next contact.
    await readHostPRAutoRefreshCadence('env-old', reader)
    expect(hostLacksPRAutoRefresh('env-old')).toBe(false)
    expect(getPRAutoRefreshCadenceForHost('env-old')).toBe('reduced')
  })

  it('does not call a host that has not answered, or whose read failed, an older host', async () => {
    expect(hostLacksPRAutoRefresh('env-new')).toBe(false)
    await readHostPRAutoRefreshCadence('env-new', async () => {
      throw new Error('offline')
    })
    expect(hostLacksPRAutoRefresh('env-new')).toBe(false)
  })
})
