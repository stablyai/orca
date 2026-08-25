import { describe, expect, it, vi } from 'vitest'
import {
  buildRuntimeClientEventEnvironmentKey,
  createRuntimeEnvironmentStoreSyncSubscriber,
  getNewlyConnectedRuntimeEnvironmentIds,
  getNewlyDisconnectedRuntimeEnvironmentIds,
  getReachableRuntimeEnvironmentIds,
  getRuntimeClientEventEnvironmentIds,
  getRuntimeProjectRefreshEnvironmentIds,
  invalidateRuntimeClientEventReplay
} from './ipc-events/runtime-environment-subscription-selection'
import type {
  RuntimeEnvironmentStoreSyncState,
  RuntimeEnvironmentStoreSyncSubscriber
} from './ipc-events/runtime-environment-subscription-selection'

describe('buildRuntimeClientEventEnvironmentKey', () => {
  it('treats runtime environment ids as a stable set', () => {
    expect(buildRuntimeClientEventEnvironmentKey(['env-b', 'env-a', 'env-b'])).toBe(
      buildRuntimeClientEventEnvironmentKey(['env-a', 'env-b'])
    )
  })
})

describe('getNewlyConnectedRuntimeEnvironmentIds', () => {
  it('returns only environments that became connected', () => {
    expect(getNewlyConnectedRuntimeEnvironmentIds(['env-a'], ['env-a', 'env-b'])).toEqual(['env-b'])
  })

  it('ignores environments that disconnected or stayed connected', () => {
    expect(getNewlyConnectedRuntimeEnvironmentIds(['env-a', 'env-b'], ['env-a'])).toEqual([])
  })

  it('treats every environment as new when none were connected before', () => {
    expect(getNewlyConnectedRuntimeEnvironmentIds([], ['env-a', 'env-a', 'env-b'])).toEqual([
      'env-a',
      'env-b'
    ])
  })
})

describe('getNewlyDisconnectedRuntimeEnvironmentIds', () => {
  it('returns only environments whose transport was just observed down', () => {
    expect(getNewlyDisconnectedRuntimeEnvironmentIds(['env-a', 'env-b'], ['env-a'])).toEqual([
      'env-b'
    ])
    expect(getNewlyDisconnectedRuntimeEnvironmentIds(['env-a'], ['env-a', 'env-b'])).toEqual([])
  })
})

describe('getRuntimeProjectRefreshEnvironmentIds', () => {
  it('refreshes when an already-desired runtime becomes reachable', () => {
    expect(
      getRuntimeProjectRefreshEnvironmentIds({
        previousDesired: ['env-a'],
        nextDesired: ['env-a'],
        previousReachable: [],
        nextReachable: ['env-a']
      })
    ).toEqual(['env-a'])
  })

  it('deduplicates runtimes that are both newly desired and newly reachable', () => {
    expect(
      getRuntimeProjectRefreshEnvironmentIds({
        previousDesired: [],
        nextDesired: ['env-a'],
        previousReachable: [],
        nextReachable: ['env-a']
      })
    ).toEqual(['env-a'])
  })
})

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
  it('does no host enumeration or key building for 1,000 unrelated local, SSH, and folder writes', () => {
    const environments = Array.from({ length: 100 }, (_, index) => ({
      id: `runtime-${index}`,
      createdAt: index + 1
    }))
    const statuses = new Map(
      environments.map((environment) => [
        environment.id,
        { status: { runtimeId: `peer-${environment.id}` }, checkedAt: 1 }
      ])
    )
    let currentState = makeRuntimeEnvironmentStoreState({ environments, statuses })
    let hostEnumerations = 0
    let keyBuilds = 0
    let syncs = 0
    const subscriber = createRuntimeEnvironmentStoreSyncSubscriber({
      initialDesiredEnvironmentIds: getRuntimeClientEventEnvironmentIds(currentState),
      initialReachableEnvironmentIds: getReachableRuntimeEnvironmentIds(currentState),
      getDesiredEnvironmentIds: (state) => {
        hostEnumerations += 1
        return getRuntimeClientEventEnvironmentIds(state)
      },
      getReachableEnvironmentIds: (state) => {
        hostEnumerations += 1
        return getReachableRuntimeEnvironmentIds(state)
      },
      buildEnvironmentKey: (environmentIds) => {
        keyBuilds += 1
        return [...environmentIds].sort().join('\0')
      },
      requestProjectRefresh: vi.fn(),
      markEnvironmentSshStateStale: vi.fn(),
      sync: () => {
        syncs += 1
      }
    })
    keyBuilds = 0

    for (let write = 0; write < 1_000; write += 1) {
      const previousState = currentState
      currentState = {
        ...currentState,
        // These represent the high-frequency boundaries that must stay outside
        // runtime-host discovery: local terminal state, direct SSH state, and
        // folder-workspace catalog churn.
        settings: {
          activeRuntimeEnvironmentId: currentState.settings?.activeRuntimeEnvironmentId ?? null,
          terminalFontSize: write
        },
        pendingStartupByTabId: { [`local-tab-${write}`]: true },
        sshConnectionStates: new Map([[`direct-ssh-${write}`, { status: 'connected' }]]),
        folderWorkspaces: [{ id: `folder-${write}` }]
      } as unknown as RuntimeEnvironmentStoreState
      subscriber(currentState, previousState)
    }

    expect(hostEnumerations).toBe(0)
    expect(keyBuilds).toBe(0)
    expect(syncs).toBe(0)
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
        // Zustand publishes this nested write synchronously. The outer pass must
        // absorb its generation instead of enumerating/syncing it a second time.
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
    const requestProjectRefresh = vi.fn()
    const markEnvironmentSshStateStale = vi.fn()
    const sync = vi.fn()
    const hydrateEnvironmentSshState = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValue(new Error('runtime stayed unreachable'))

    invalidateRuntimeClientEventReplay({
      getSshStateReference: () => sshStateReference,
      requestProjectRefresh,
      markEnvironmentSshStateStale,
      hydrateEnvironmentSshState,
      sync
    })
    await Promise.resolve()

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
