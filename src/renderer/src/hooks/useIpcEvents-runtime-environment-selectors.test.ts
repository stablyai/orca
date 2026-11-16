import { describe, expect, it, vi } from 'vitest'
import {
  createRuntimeEnvironmentStoreSyncSubscriber,
  getReachableRuntimeEnvironmentIds,
  getRuntimeClientEventEnvironmentIds,
  invalidateRuntimeClientEventReplay
} from './ipc-events/runtime-environment-subscription-selection'
import type {
  RuntimeEnvironmentStoreSyncState,
  RuntimeEnvironmentStoreSyncSubscriber
} from './ipc-events/runtime-environment-subscription-selection'

import { createRuntimeClientEventsSync } from './runtime-client-events-sync'

type RuntimeEnvironmentStoreSubscriber = RuntimeEnvironmentStoreSyncSubscriber
type RuntimeEnvironmentStoreState = RuntimeEnvironmentStoreSyncState

function makeRuntimeEnvironmentStoreState(args: {
  environments: readonly { id: string; createdAt: number; pairingRevision?: number }[]
  statuses: ReadonlyMap<string, { status: { runtimeId: string } | null; checkedAt: number }>
  sshStateByEnvironment?: ReadonlyMap<string, unknown>
  activeEnvironmentId?: string | null
  settingsRevision?: number
}): RuntimeEnvironmentStoreState {
  return {
    runtimeEnvironments: args.environments,
    runtimeStatusByEnvironmentId: args.statuses,
    sshStateByEnvironment: args.sshStateByEnvironment ?? new Map(),
    settings: {
      activeRuntimeEnvironmentId: args.activeEnvironmentId ?? null,
      terminalFontSize: args.settingsRevision ?? 0
    }
  } as unknown as RuntimeEnvironmentStoreState
}

describe('createRuntimeEnvironmentStoreSyncSubscriber', () => {
  it('retires removed registry members despite retained status and follows active host changes', async () => {
    const environments = [
      { id: 'A', createdAt: 1 },
      { id: 'B', createdAt: 2 }
    ]
    const statuses = new Map([
      ['A', { status: { runtimeId: 'peer-a' }, checkedAt: 1 }],
      ['B', { status: { runtimeId: 'peer-b' }, checkedAt: 1 }]
    ])
    let state = makeRuntimeEnvironmentStoreState({ environments, statuses })
    const subscriptions: string[] = []
    const retirements: string[] = []
    const wakes: (readonly string[] | undefined)[] = []
    const manager = createRuntimeClientEventsSync({
      getDesiredEnvironmentIds: () => getRuntimeClientEventEnvironmentIds(state),
      subscribe: (id) => {
        subscriptions.push(id)
        return Promise.resolve({
          unsubscribe: () => {
            retirements.push(id)
          }
        })
      },
      onEvent: vi.fn()
    })
    const subscriber = createRuntimeEnvironmentStoreSyncSubscriber({
      initialDesiredEnvironmentIds: getRuntimeClientEventEnvironmentIds(state),
      initialReachableEnvironmentIds: getReachableRuntimeEnvironmentIds(state),
      getDesiredEnvironmentIds: getRuntimeClientEventEnvironmentIds,
      getReachableEnvironmentIds: getReachableRuntimeEnvironmentIds,
      buildEnvironmentKey: (ids) => [...ids].sort().join(':'),
      requestProjectRefresh: vi.fn(),
      markEnvironmentSshStateStale: vi.fn(),
      sync: (ids) => {
        wakes.push(ids)
        manager.sync(ids)
      }
    })
    const publish = (next: RuntimeEnvironmentStoreState): void => {
      const previous = state
      state = next
      subscriber(state, previous)
    }
    manager.sync()
    await Promise.resolve()
    publish(makeRuntimeEnvironmentStoreState({ environments: [environments[1]], statuses }))
    expect(retirements).toEqual(['A'])
    expect(wakes).toEqual([[]])
    publish(
      makeRuntimeEnvironmentStoreState({
        environments: [environments[1]],
        statuses,
        activeEnvironmentId: 'C'
      })
    )
    await Promise.resolve()
    expect(subscriptions).toEqual(['A', 'B', 'C'])
    expect(wakes).toEqual([[], ['C']])
    publish(
      makeRuntimeEnvironmentStoreState({
        environments: [environments[1]],
        statuses,
        activeEnvironmentId: 'D'
      })
    )
    await Promise.resolve()
    expect(retirements).toEqual(['A', 'C'])
    expect(subscriptions).toEqual(['A', 'B', 'C', 'D'])
    expect(wakes).toEqual([[], ['C'], ['D']])
    manager.stop()
  })

  it('syncs each connect, disconnect, re-pair, runtime generation, and nested SSH generation once', () => {
    let environments = [
      { id: 'runtime-a', createdAt: 1, pairingRevision: 1 },
      { id: 'runtime-b', createdAt: 2, pairingRevision: 1 }
    ]
    let statuses = new Map([
      ['runtime-a', { status: { runtimeId: 'peer-a' }, checkedAt: 1 }],
      ['runtime-b', { status: null, checkedAt: 1 }]
    ])
    let sshStateByEnvironment: ReadonlyMap<string, unknown> = new Map([
      ['runtime-a', { targetsHydrated: true }]
    ])
    let currentState = makeRuntimeEnvironmentStoreState({
      environments,
      statuses,
      sshStateByEnvironment,
      activeEnvironmentId: 'runtime-a'
    })
    const runtimeGenerations = new Map([
      ['runtime-a', 1],
      ['runtime-b', 0]
    ])
    const sshGenerations = new Map([
      ['runtime-a', 0],
      ['runtime-b', 0]
    ])
    const pairingRevisions = new Map([
      ['runtime-a', 1],
      ['runtime-b', 1]
    ])
    const refreshes: string[] = []
    let syncs = 0
    let subscriber: RuntimeEnvironmentStoreSubscriber
    const publish = (nextState: RuntimeEnvironmentStoreState): void => {
      const previousState = currentState
      currentState = nextState
      subscriber(nextState, previousState)
    }
    const buildEnvironmentKey = (environmentIds: string[]): string =>
      [...new Set(environmentIds)]
        .sort()
        .map(
          (environmentId) =>
            `${environmentId}:${runtimeGenerations.get(environmentId) ?? 0}:${sshGenerations.get(environmentId) ?? 0}:${pairingRevisions.get(environmentId) ?? 0}`
        )
        .join('\0')

    subscriber = createRuntimeEnvironmentStoreSyncSubscriber({
      initialDesiredEnvironmentIds: getRuntimeClientEventEnvironmentIds(currentState),
      initialReachableEnvironmentIds: getReachableRuntimeEnvironmentIds(currentState),
      getDesiredEnvironmentIds: getRuntimeClientEventEnvironmentIds,
      getReachableEnvironmentIds: getReachableRuntimeEnvironmentIds,
      buildEnvironmentKey,
      requestProjectRefresh: (environmentId) => refreshes.push(environmentId),
      markEnvironmentSshStateStale: (environmentId) => {
        sshGenerations.set(environmentId, (sshGenerations.get(environmentId) ?? 0) + 1)
        const previousState = currentState
        sshStateByEnvironment = new Map(sshStateByEnvironment).set(environmentId, {
          targetsHydrated: false
        })
        currentState = makeRuntimeEnvironmentStoreState({
          environments,
          statuses,
          sshStateByEnvironment,
          activeEnvironmentId: 'runtime-a'
        })
        // The outer pass must absorb synchronous nested generation changes without syncing twice.
        subscriber(currentState, previousState)
      },
      sync: () => {
        syncs += 1
      }
    })

    runtimeGenerations.set('runtime-b', 1)
    statuses = new Map(statuses).set('runtime-b', {
      status: { runtimeId: 'peer-b' },
      checkedAt: 2
    })
    publish(
      makeRuntimeEnvironmentStoreState({
        environments,
        statuses,
        sshStateByEnvironment,
        activeEnvironmentId: 'runtime-a'
      })
    )
    expect(syncs).toBe(1)
    expect(refreshes).toEqual(['runtime-b'])

    statuses = new Map(statuses).set('runtime-a', { status: null, checkedAt: 3 })
    publish(
      makeRuntimeEnvironmentStoreState({
        environments,
        statuses,
        sshStateByEnvironment,
        activeEnvironmentId: 'runtime-a'
      })
    )
    expect(syncs).toBe(2)

    environments = [environments[0], { ...environments[1], pairingRevision: 2 }]
    pairingRevisions.set('runtime-b', 2)
    publish(
      makeRuntimeEnvironmentStoreState({
        environments,
        statuses,
        sshStateByEnvironment,
        activeEnvironmentId: 'runtime-a'
      })
    )
    expect(syncs).toBe(3)

    runtimeGenerations.set('runtime-b', 2)
    statuses = new Map(statuses).set('runtime-b', {
      status: { runtimeId: 'peer-b-reconnected' },
      checkedAt: 4
    })
    publish(
      makeRuntimeEnvironmentStoreState({
        environments,
        statuses,
        sshStateByEnvironment,
        activeEnvironmentId: 'runtime-a'
      })
    )
    expect(syncs).toBe(4)

    sshGenerations.set('runtime-b', 1)
    sshStateByEnvironment = new Map(sshStateByEnvironment).set('runtime-b', {
      targetsHydrated: true
    })
    publish(
      makeRuntimeEnvironmentStoreState({
        environments,
        statuses,
        sshStateByEnvironment,
        activeEnvironmentId: 'runtime-a'
      })
    )
    expect(syncs).toBe(5)
  })
})

describe('invalidateRuntimeClientEventReplay', () => {
  it('explicitly syncs an advanced SSH generation when stale publication is a no-op and hydration fails', async () => {
    const sshStateReference = new Map()
    const refreshRuntimeStatus = vi.fn()
    const requestProjectRefresh = vi.fn()
    const markEnvironmentSshStateStale = vi.fn()
    const sync = vi.fn()
    const hydrateEnvironmentSshState = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValue(new Error('runtime stayed unreachable'))

    invalidateRuntimeClientEventReplay({
      getSshStateReference: () => sshStateReference,
      refreshRuntimeStatus,
      requestProjectRefresh,
      markEnvironmentSshStateStale,
      hydrateEnvironmentSshState,
      sync
    })
    await Promise.resolve()

    expect(refreshRuntimeStatus).toHaveBeenCalledOnce()
    expect(requestProjectRefresh).toHaveBeenCalledOnce()
    expect(markEnvironmentSshStateStale).toHaveBeenCalledOnce()
    expect(sync).toHaveBeenCalledOnce()
    expect(hydrateEnvironmentSshState).toHaveBeenCalledOnce()
  })

  it('leaves tracked bucket publications to the synchronous store subscriber', () => {
    let sshStateReference = new Map()
    const sync = vi.fn()

    invalidateRuntimeClientEventReplay({
      getSshStateReference: () => sshStateReference,
      refreshRuntimeStatus: vi.fn(),
      requestProjectRefresh: vi.fn(),
      markEnvironmentSshStateStale: () => {
        sshStateReference = new Map()
      },
      hydrateEnvironmentSshState: () => Promise.resolve(),
      sync
    })

    expect(sync).not.toHaveBeenCalled()
  })
})
