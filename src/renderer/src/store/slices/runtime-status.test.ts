import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { toast } from 'sonner'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { createCompatibleRuntimeStatusResponse } from '../../runtime/runtime-compatibility-test-fixture'
import {
  callRuntimeRpc,
  clearRuntimeCompatibilityCacheForTests
} from '../../runtime/runtime-rpc-client'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  createRuntimeStatusSlice,
  type RuntimeStatusSlice,
  getRuntimeEnvironmentConnectionGeneration
} from './runtime-status'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { getPairedDeviceIdsByEnvironment } from '@/components/sidebar/workspace-creator-visibility'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), dismiss: vi.fn() }
}))

function createSliceStore() {
  return create<RuntimeStatusSlice>()((...a) => ({
    ...createRuntimeStatusSlice(...(a as unknown as Parameters<typeof createRuntimeStatusSlice>))
  }))
}

function makeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    runtimeId: 'rt',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 3,
    ...overrides
  } as RuntimeStatus
}

function makeEnvironment(
  overrides: Partial<PublicKnownRuntimeEnvironment> = {}
): PublicKnownRuntimeEnvironment {
  return {
    id: 'env-a',
    name: 'Dev Box',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws-a', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
    preferredEndpointId: 'ws-a',
    ...overrides
  }
}

function stubRuntimeEnvironmentApi({
  getStatus = vi.fn(),
  list = vi.fn()
}: {
  getStatus?: ReturnType<typeof vi.fn>
  list?: ReturnType<typeof vi.fn>
}) {
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        getStatus,
        list
      }
    }
  })
  return { getStatus, list }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason?: unknown) => void = () => {}
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  vi.mocked(toast.warning).mockReset()
  vi.mocked(toast.dismiss).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('runtime-status slice', () => {
  it('starts with an empty map', () => {
    const store = createSliceStore()
    expect(store.getState().runtimeEnvironments).toEqual([])
    expect(store.getState().runtimeEnvironmentCatalogHydrated).toBe(false)
    expect(store.getState().runtimeStatusByEnvironmentId.size).toBe(0)
  })

  it('stores saved runtime environments and trims stale statuses', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('keep', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('drop', { status: makeStatus(), checkedAt: 1 })

    store.getState().setRuntimeEnvironments([
      {
        id: 'keep',
        name: 'Dev Box',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws-keep', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
        preferredEndpointId: 'ws-keep'
      }
    ])

    expect(store.getState().runtimeEnvironments.map((environment) => environment.name)).toEqual([
      'Dev Box'
    ])
    expect(store.getState().runtimeEnvironmentCatalogHydrated).toBe(true)
    expect(store.getState().runtimeStatusByEnvironmentId.has('keep')).toBe(true)
    expect(store.getState().runtimeStatusByEnvironmentId.has('drop')).toBe(false)
  })

  it('drops old status and advances generation when the same environment id is re-paired', () => {
    const store = createSliceStore()
    const purgeStaleRuntimeHostState = vi.fn()
    store.setState({ purgeStaleRuntimeHostState } as never)
    store
      .getState()
      .setRuntimeEnvironments([{ id: 'env-a', createdAt: 1, pairingRevision: 1 } as never])
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ runtimeId: 'same-runtime' }),
      checkedAt: 1
    })
    const before = getRuntimeEnvironmentConnectionGeneration('env-a')

    store
      .getState()
      .setRuntimeEnvironments([{ id: 'env-a', createdAt: 1, pairingRevision: 2 } as never])

    expect(store.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
    expect(getRuntimeEnvironmentConnectionGeneration('env-a')).toBe(before + 1)
    expect(purgeStaleRuntimeHostState).toHaveBeenCalledWith(['env-a'])
  })

  it('merges per environment id and produces a new map reference', () => {
    const store = createSliceStore()
    const before = store.getState().runtimeStatusByEnvironmentId

    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus(),
      checkedAt: 1
    })
    const afterFirst = store.getState().runtimeStatusByEnvironmentId
    expect(afterFirst).not.toBe(before)
    expect(afterFirst.get('env-a')?.checkedAt).toBe(1)

    store.getState().setRuntimeEnvironmentStatus('env-b', {
      status: null,
      checkedAt: 2
    })
    const afterSecond = store.getState().runtimeStatusByEnvironmentId
    expect(afterSecond.size).toBe(2)
    expect(afterSecond.get('env-a')?.checkedAt).toBe(1)
    expect(afterSecond.get('env-b')?.status).toBeNull()
  })

  it('overwrites the prior entry for the same id', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 5 })

    const map = store.getState().runtimeStatusByEnvironmentId
    expect(map.size).toBe(1)
    expect(map.get('env-a')).toEqual({ status: null, checkedAt: 5, connectionGeneration: 1 })
  })

  it('retains a learned paired device id after disconnecting a legacy environment', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironments([makeEnvironment()])
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ pairedDeviceId: 'client-device' }),
      checkedAt: 1
    })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 2 })

    expect(
      getPairedDeviceIdsByEnvironment(
        store.getState().runtimeEnvironments,
        store.getState().runtimeStatusByEnvironmentId
      ).get('env-a')
    ).toBe('client-device')
  })

  it('still learns a paired device id when the re-probed status is unchanged', () => {
    const store = createSliceStore()
    // Why: the status arrives before the catalog, so only the second (identical) probe
    // can carry the id onto the environment — the map guard must not swallow it.
    const status = makeStatus({ pairedDeviceId: 'client-device' })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status, checkedAt: 1 })
    store.getState().setRuntimeEnvironments([makeEnvironment()])
    const before = store.getState().runtimeStatusByEnvironmentId

    store.getState().setRuntimeEnvironmentStatus('env-a', { status, checkedAt: 2 })

    expect(store.getState().runtimeEnvironments[0].pairedDeviceId).toBe('client-device')
    expect(store.getState().runtimeStatusByEnvironmentId).toBe(before)
  })

  it('keeps the map reference when a re-probe returns an identical status', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    const before = store.getState().runtimeStatusByEnvironmentId
    const entryBefore = before.get('env-a')
    const generationBefore = getRuntimeEnvironmentConnectionGeneration('env-a')

    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 2 })

    expect(store.getState().runtimeStatusByEnvironmentId).toBe(before)
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')).toBe(entryBefore)
    expect(getRuntimeEnvironmentConnectionGeneration('env-a')).toBe(generationBefore)
  })

  it('keeps the map reference when an unreachable server is re-probed', () => {
    const store = createSliceStore()
    store.setState({ runtimeEnvironments: [makeEnvironment()] })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 1 })
    const before = store.getState().runtimeStatusByEnvironmentId

    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 2 })

    expect(store.getState().runtimeStatusByEnvironmentId).toBe(before)
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('replaces the map when any status field changes, nested ones included', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ liveTabCount: 1, capabilities: ['a'] }),
      checkedAt: 1
    })
    const afterFirst = store.getState().runtimeStatusByEnvironmentId

    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ liveTabCount: 2, capabilities: ['a'] }),
      checkedAt: 2
    })
    const afterScalarChange = store.getState().runtimeStatusByEnvironmentId
    expect(afterScalarChange).not.toBe(afterFirst)
    expect(afterScalarChange.get('env-a')?.checkedAt).toBe(2)

    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ liveTabCount: 2, capabilities: ['a', 'b'] }),
      checkedAt: 3
    })
    const afterNestedChange = store.getState().runtimeStatusByEnvironmentId
    expect(afterNestedChange).not.toBe(afterScalarChange)
    expect(afterNestedChange.get('env-a')?.status?.capabilities).toEqual(['a', 'b'])
  })

  it('still writes and toasts across null and non-null transitions', () => {
    const store = createSliceStore()
    store.setState({ runtimeEnvironments: [makeEnvironment()] })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    const connected = store.getState().runtimeStatusByEnvironmentId
    const generationConnected = getRuntimeEnvironmentConnectionGeneration('env-a')

    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 2 })
    const disconnected = store.getState().runtimeStatusByEnvironmentId
    expect(disconnected).not.toBe(connected)
    expect(disconnected.get('env-a')?.status).toBeNull()
    expect(toast.warning).toHaveBeenCalledTimes(1)

    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 3 })
    const reconnected = store.getState().runtimeStatusByEnvironmentId
    expect(reconnected).not.toBe(disconnected)
    expect(getRuntimeEnvironmentConnectionGeneration('env-a')).toBe(generationConnected + 1)
    expect(reconnected.get('env-a')?.connectionGeneration).toBe(generationConnected + 1)
    expect(toast.dismiss).toHaveBeenCalledWith('runtime-environment-disconnected:env-a')
  })

  it('replaces the map when the same status arrives under a new runtime id', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ runtimeId: 'runtime-a' }),
      checkedAt: 1
    })
    const before = store.getState().runtimeStatusByEnvironmentId

    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ runtimeId: 'runtime-b' }),
      checkedAt: 2
    })

    expect(store.getState().runtimeStatusByEnvironmentId).not.toBe(before)
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration).toBe(2)
  })

  it('does not toast when the first probe finds a saved server offline', () => {
    const store = createSliceStore()
    store.setState({ runtimeEnvironments: [makeEnvironment()] })

    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 1 })

    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('toasts once when a connected server becomes unavailable', () => {
    const store = createSliceStore()
    store.setState({ runtimeEnvironments: [makeEnvironment()] })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })

    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 2 })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 3 })

    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledWith(
      "Can't reach Dev Box",
      expect.objectContaining({
        id: 'runtime-environment-disconnected:env-a',
        description:
          'Check that Orca is running on this server and that your network connection is working, then try again.',
        action: expect.objectContaining({ label: 'Try again' })
      })
    )
  })

  it('dismisses the disconnect toast when the server recovers', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 2 })

    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 3 })

    expect(toast.dismiss).toHaveBeenCalledWith('runtime-environment-disconnected:env-a')
  })

  it('keeps the keyed action toast visible when an offline retry settles', async () => {
    vi.useFakeTimers()
    const toastId = 'runtime-environment-disconnected:env-a'
    const visibleToastIds = new Set<string | number>()
    vi.mocked(toast.warning).mockImplementation((_title, options) => {
      if (options?.id !== undefined) {
        visibleToastIds.add(options.id)
      }
      return options?.id ?? ''
    })
    const getStatus = vi.fn().mockRejectedValue(new Error('closed'))
    stubRuntimeEnvironmentApi({ getStatus })
    const store = createSliceStore()
    store.setState({ runtimeEnvironments: [makeEnvironment()] })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 2 })
    const options = vi.mocked(toast.warning).mock.calls[0]?.[1] as unknown as {
      action: { onClick: (event: { preventDefault: () => void }) => void }
    }
    const clickAction = (): { defaultPrevented: boolean } => {
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
        }
      }
      options.action.onClick(event)
      if (!event.defaultPrevented) {
        setTimeout(() => visibleToastIds.delete(toastId), 200)
      }
      return event
    }

    const firstClick = clickAction()
    const secondClick = clickAction()
    await vi.advanceTimersByTimeAsync(0)

    expect(firstClick.defaultPrevented).toBe(true)
    expect(secondClick.defaultPrevented).toBe(true)
    expect(getStatus).toHaveBeenCalledWith({ selector: 'env-a', timeoutMs: 10_000 })
    await vi.advanceTimersByTimeAsync(200)
    expect(visibleToastIds.has(toastId)).toBe(true)
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledTimes(3)
    expect(vi.mocked(toast.warning).mock.calls.map((call) => call[1]?.duration)).toEqual([
      4_000,
      Number.POSITIVE_INFINITY,
      4_000
    ])
    expect(vi.mocked(toast.warning).mock.calls.every((call) => call[1]?.id === toastId)).toBe(true)
  })

  it('does not report removal or explicit status clearing as a disconnect', () => {
    const store = createSliceStore()
    store.setState({ runtimeEnvironments: [makeEnvironment()] })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })

    store.getState().clearRuntimeEnvironmentStatus('env-a')
    store.getState().setRuntimeEnvironments([])

    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('does not report an intentional disconnect as an outage', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })

    store
      .getState()
      .setRuntimeEnvironmentStatus(
        'env-a',
        { status: null, checkedAt: 2 },
        { suppressDisconnectToast: true }
      )

    expect(toast.warning).not.toHaveBeenCalled()
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status).toBeNull()
  })

  it('dismisses an outage toast opened while an intentional disconnect was pending', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 2 })

    store
      .getState()
      .setRuntimeEnvironmentStatus(
        'env-a',
        { status: null, checkedAt: 3 },
        { suppressDisconnectToast: true }
      )

    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(toast.dismiss).toHaveBeenCalledWith('runtime-environment-disconnected:env-a')
  })

  it('clears a single environment entry', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('env-b', { status: makeStatus(), checkedAt: 1 })

    store.getState().clearRuntimeEnvironmentStatus('env-a')
    expect(store.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
    expect(store.getState().runtimeStatusByEnvironmentId.has('env-b')).toBe(true)
  })

  it('no-ops clearing an unknown id without creating a new reference', () => {
    const store = createSliceStore()
    const before = store.getState().runtimeStatusByEnvironmentId
    store.getState().clearRuntimeEnvironmentStatus('missing')
    expect(store.getState().runtimeStatusByEnvironmentId).toBe(before)
  })

  it('retains only saved environment ids', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('keep', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('drop', { status: makeStatus(), checkedAt: 1 })

    store.getState().retainRuntimeEnvironmentStatuses(['keep'])
    const map = store.getState().runtimeStatusByEnvironmentId
    expect(map.has('keep')).toBe(true)
    expect(map.has('drop')).toBe(false)
  })

  it('no-ops retain when nothing is dropped', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('keep', { status: makeStatus(), checkedAt: 1 })
    const before = store.getState().runtimeStatusByEnvironmentId

    store.getState().retainRuntimeEnvironmentStatuses(['keep', 'unrelated'])
    expect(store.getState().runtimeStatusByEnvironmentId).toBe(before)
  })

  it('refreshes one runtime environment status and repairs a stale null entry', async () => {
    const getStatus = vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a'))
    stubRuntimeEnvironmentApi({ getStatus })
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 1 })

    const reachable = await store.getState().refreshRuntimeEnvironmentStatus('env-a', 5_000)

    expect(reachable).toBe(true)
    expect(getStatus).toHaveBeenCalledWith({ selector: 'env-a', timeoutMs: 5_000 })
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.runtimeId).toBe(
      'runtime-a'
    )
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration).toBe(1)
  })

  it.each(['success', 'failure'] as const)(
    'drops a stale refresh %s after the same environment id is re-paired',
    async (outcome) => {
      const probe = deferred<ReturnType<typeof createCompatibleRuntimeStatusResponse>>()
      const getStatus = vi.fn().mockReturnValue(probe.promise)
      stubRuntimeEnvironmentApi({ getStatus })
      const store = createSliceStore()
      store.getState().setRuntimeEnvironments([makeEnvironment({ pairingRevision: 1 })])

      const refresh = store.getState().refreshRuntimeEnvironmentStatus('env-a')
      store.getState().setRuntimeEnvironments([makeEnvironment({ pairingRevision: 2 })])
      if (outcome === 'success') {
        probe.resolve(createCompatibleRuntimeStatusResponse('runtime-old'))
      } else {
        probe.reject(new Error('old connection closed'))
      }

      await expect(refresh).resolves.toBe(false)
      expect(store.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
    }
  )

  it('advances connection generation after recovery without churning stable status polls', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ runtimeId: 'runtime-a' }),
      checkedAt: 1
    })
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ runtimeId: 'runtime-a' }),
      checkedAt: 2
    })
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration).toBe(1)

    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 3 })
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ runtimeId: 'runtime-a' }),
      checkedAt: 4
    })
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration).toBe(2)
  })

  it('keeps stored and canonical generations aligned after same-id re-pairing', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironments([makeEnvironment({ pairingRevision: 1 })])
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ runtimeId: 'runtime-a' }),
      checkedAt: 1
    })

    store.getState().setRuntimeEnvironments([makeEnvironment({ pairingRevision: 2 })])
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ runtimeId: 'runtime-b' }),
      checkedAt: 2
    })

    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration).toBe(
      getRuntimeEnvironmentConnectionGeneration('env-a')
    )
    expect(getRuntimeEnvironmentConnectionGeneration('env-a')).toBe(3)
  })

  it('invalidates provider state only when the active runtime session changes', () => {
    const store = createSliceStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-a' } } as never)
    const initialKey = getProviderRuntimeContextKey({ activeRuntimeEnvironmentId: 'env-a' })

    store.getState().setRuntimeEnvironmentStatus('env-b', {
      status: makeStatus({ runtimeId: 'runtime-b' }),
      checkedAt: 1
    })
    expect(getProviderRuntimeContextKey({ activeRuntimeEnvironmentId: 'env-a' })).toBe(initialKey)

    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ runtimeId: 'runtime-a' }),
      checkedAt: 2
    })
    const connectedKey = getProviderRuntimeContextKey({ activeRuntimeEnvironmentId: 'env-a' })
    expect(connectedKey).not.toBe(initialKey)

    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus({ runtimeId: 'runtime-a' }),
      checkedAt: 3
    })
    expect(getProviderRuntimeContextKey({ activeRuntimeEnvironmentId: 'env-a' })).toBe(connectedKey)

    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 4 })
    expect(getProviderRuntimeContextKey({ activeRuntimeEnvironmentId: 'env-a' })).not.toBe(
      connectedKey
    )
  })

  it('drops a recent compatibility failure once a status refresh succeeds', async () => {
    clearRuntimeCompatibilityCacheForTests()
    let offline = true
    const call = vi.fn().mockImplementation(({ method }: { method: string }) => {
      if (offline || method === 'status.get') {
        return Promise.resolve(
          offline
            ? {
                id: 'status',
                ok: false,
                error: { code: 'runtime_unavailable', message: 'offline' },
                _meta: { runtimeId: 'runtime-a' }
              }
            : createCompatibleRuntimeStatusResponse('runtime-a')
        )
      }
      return Promise.resolve({ id: method, ok: true, result: { ok: true }, _meta: {} })
    })
    const getStatus = vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a'))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { getStatus, call } } })
    const store = createSliceStore()
    const target = { kind: 'environment', environmentId: 'env-a' } as const

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')
    // Reuse-flagged callers stay pinned to the recent failure until recovery.
    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')

    offline = false
    await store.getState().refreshRuntimeEnvironmentStatus('env-a')

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).resolves.toEqual({ ok: true })
    clearRuntimeCompatibilityCacheForTests()
  })

  it('drops a recent compatibility failure on a direct non-null status publish', async () => {
    // Why: paths like Settings "Connect" publish the host online via
    // setRuntimeEnvironmentStatus directly (not refreshRuntimeEnvironmentStatus)
    // and then trigger a reuse-flagged repo.list. The stale failure must drop so
    // that reuse-flagged catalog fetch re-probes the now-reachable host.
    clearRuntimeCompatibilityCacheForTests()
    let offline = true
    const call = vi.fn().mockImplementation(({ method }: { method: string }) => {
      if (offline || method === 'status.get') {
        return Promise.resolve(
          offline
            ? {
                id: 'status',
                ok: false,
                error: { code: 'runtime_unavailable', message: 'offline' },
                _meta: { runtimeId: 'runtime-a' }
              }
            : createCompatibleRuntimeStatusResponse('runtime-a')
        )
      }
      return Promise.resolve({ id: method, ok: true, result: { ok: true }, _meta: {} })
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    const store = createSliceStore()
    const target = { kind: 'environment', environmentId: 'env-a' } as const

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')

    offline = false
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).resolves.toEqual({ ok: true })
    clearRuntimeCompatibilityCacheForTests()
  })

  it('preserves a recent compatibility failure on a null (offline) status publish', async () => {
    // Why: recording an unreachable host must not undermine the fanout fix — a
    // null status is not proof of reachability, so reuse-flagged sweeps keep
    // reusing the one recent failure instead of re-probing per repo.
    clearRuntimeCompatibilityCacheForTests()
    let offline = true
    const call = vi.fn().mockImplementation(({ method }: { method: string }) => {
      if (offline || method === 'status.get') {
        return Promise.resolve(
          offline
            ? {
                id: 'status',
                ok: false,
                error: { code: 'runtime_unavailable', message: 'offline' },
                _meta: { runtimeId: 'runtime-a' }
              }
            : createCompatibleRuntimeStatusResponse('runtime-a')
        )
      }
      return Promise.resolve({ id: method, ok: true, result: { ok: true }, _meta: {} })
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    const store = createSliceStore()
    const target = { kind: 'environment', environmentId: 'env-a' } as const

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')

    // A null publish (host still unreachable) must keep the failure pinned even
    // after the transport would answer, so the reuse-flagged caller does not probe.
    offline = false
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 1 })

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')
    clearRuntimeCompatibilityCacheForTests()
  })

  it('records null and returns false when a runtime refresh fails', async () => {
    const getStatus = vi.fn().mockRejectedValue(new Error('closed'))
    stubRuntimeEnvironmentApi({ getStatus })
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })

    const reachable = await store.getState().refreshRuntimeEnvironmentStatus('env-a')

    expect(reachable).toBe(false)
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status).toBeNull()
  })

  it('hydrates saved environments through the single-environment refresh path', async () => {
    const getStatus = vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a'))
    const list = vi.fn().mockResolvedValue([
      {
        id: 'env-a',
        name: 'Dev Box',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws-a', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
        preferredEndpointId: 'ws-a'
      }
    ])
    stubRuntimeEnvironmentApi({ getStatus, list })
    const store = createSliceStore()

    await store.getState().hydrateRuntimeEnvironmentStatuses()

    expect(store.getState().runtimeEnvironments.map((environment) => environment.id)).toEqual([
      'env-a'
    ])
    expect(getStatus).toHaveBeenCalledWith({ selector: 'env-a', timeoutMs: 10_000 })
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.runtimeId).toBe(
      'runtime-a'
    )
  })

  it('shares one full catalog and status sweep across overlapping hydrations', async () => {
    const environments = [makeEnvironment(), makeEnvironment({ id: 'env-b', name: 'Build Box' })]
    const probeA = deferred<ReturnType<typeof createCompatibleRuntimeStatusResponse>>()
    const probeB = deferred<ReturnType<typeof createCompatibleRuntimeStatusResponse>>()
    const getStatus = vi.fn(({ selector }: { selector: string }) =>
      selector === 'env-a' ? probeA.promise : probeB.promise
    )
    const list = vi.fn().mockResolvedValue(environments)
    stubRuntimeEnvironmentApi({ getStatus, list })
    const store = createSliceStore()
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    const first = store.getState().hydrateRuntimeEnvironmentStatuses()
    const second = store.getState().hydrateRuntimeEnvironmentStatuses()
    expect(list).toHaveBeenCalledTimes(1)
    expect(getStatus).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2))
    const third = store.getState().hydrateRuntimeEnvironmentStatuses()

    probeA.resolve(createCompatibleRuntimeStatusResponse('runtime-a'))
    probeB.reject(new Error('offline'))
    await Promise.all([first, second, third])
    unsubscribe()

    expect(list).toHaveBeenCalledTimes(1)
    expect(getStatus).toHaveBeenCalledTimes(2)
    expect(publications).toBe(3)
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.runtimeId).toBe(
      'runtime-a'
    )
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-b')?.status).toBeNull()
  })

  it('runs a fresh explicit hydration after the shared sweep settles', async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(createCompatibleRuntimeStatusResponse('runtime-1'))
      .mockResolvedValueOnce(createCompatibleRuntimeStatusResponse('runtime-2'))
    const list = vi.fn().mockResolvedValue([makeEnvironment()])
    stubRuntimeEnvironmentApi({ getStatus, list })
    const store = createSliceStore()
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    await store.getState().hydrateRuntimeEnvironmentStatuses()
    await store.getState().hydrateRuntimeEnvironmentStatuses()
    unsubscribe()

    expect(list).toHaveBeenCalledTimes(2)
    expect(getStatus).toHaveBeenCalledTimes(2)
    expect(publications).toBe(3)
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.runtimeId).toBe(
      'runtime-2'
    )
  })

  it('does not share hydration work between stores', async () => {
    const list = vi.fn().mockResolvedValue([])
    stubRuntimeEnvironmentApi({ getStatus: vi.fn(), list })
    const firstStore = createSliceStore()
    const secondStore = createSliceStore()

    await Promise.all([
      firstStore.getState().hydrateRuntimeEnvironmentStatuses(),
      secondStore.getState().hydrateRuntimeEnvironmentStatuses()
    ])

    expect(list).toHaveBeenCalledTimes(2)
  })

  it('queues a current-catalog sweep when the catalog changes during listing', async () => {
    const environmentA = makeEnvironment({ pairingRevision: 1 })
    const repairedEnvironmentA = makeEnvironment({ pairingRevision: 2 })
    const firstCatalog = deferred<PublicKnownRuntimeEnvironment[]>()
    const secondCatalog = deferred<PublicKnownRuntimeEnvironment[]>()
    const getStatus = vi
      .fn()
      .mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-current'))
    const list = vi
      .fn()
      .mockReturnValueOnce(firstCatalog.promise)
      .mockReturnValueOnce(secondCatalog.promise)
    stubRuntimeEnvironmentApi({ getStatus, list })
    const store = createSliceStore()
    store.getState().setRuntimeEnvironments([environmentA])

    const hydration = store.getState().hydrateRuntimeEnvironmentStatuses()
    store.getState().setRuntimeEnvironments([repairedEnvironmentA])
    firstCatalog.resolve([environmentA])
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))

    expect(getStatus).not.toHaveBeenCalled()
    expect(store.getState().runtimeEnvironments).toEqual([repairedEnvironmentA])

    secondCatalog.resolve([repairedEnvironmentA])
    await hydration

    expect(list).toHaveBeenCalledTimes(2)
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(store.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(true)
  })

  it('queues one current-catalog sweep when a host is removed during probing', async () => {
    const environmentA = makeEnvironment()
    const environmentB = makeEnvironment({ id: 'env-b', name: 'Build Box' })
    const firstProbe = deferred<ReturnType<typeof createCompatibleRuntimeStatusResponse>>()
    const getStatus = vi
      .fn()
      .mockImplementationOnce(() => firstProbe.promise)
      .mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-current'))
    const list = vi
      .fn()
      .mockResolvedValueOnce([environmentA, environmentB])
      .mockResolvedValueOnce([environmentA])
    stubRuntimeEnvironmentApi({ getStatus, list })
    const store = createSliceStore()

    const first = store.getState().hydrateRuntimeEnvironmentStatuses()
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2))
    store.getState().setRuntimeEnvironments([environmentA])
    const joined = store.getState().hydrateRuntimeEnvironmentStatuses()
    firstProbe.resolve(createCompatibleRuntimeStatusResponse('runtime-old'))
    await Promise.all([first, joined])

    expect(list).toHaveBeenCalledTimes(2)
    expect(getStatus).toHaveBeenCalledTimes(3)
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.runtimeId).toBe(
      'runtime-current'
    )
    expect(store.getState().runtimeStatusByEnvironmentId.has('env-b')).toBe(false)
  })

  // Why: skill discovery waits for the catalog to settle. A rejected read must
  // release that wait without claiming the catalog is hydrated — host routing
  // uses `runtimeEnvironmentCatalogHydrated` to fail closed on an unknown
  // catalog, and an empty stale list must not be mistaken for "no runtimes".
  it('settles failed catalog reads and allows a later hydration retry', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('unreadable environments.json'))
      .mockResolvedValueOnce([])
    stubRuntimeEnvironmentApi({ getStatus: vi.fn(), list })
    const store = createSliceStore()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await store.getState().hydrateRuntimeEnvironmentStatuses()

      expect(store.getState().runtimeEnvironmentCatalogSettled).toBe(true)
      expect(store.getState().runtimeEnvironmentCatalogHydrated).toBe(false)
      expect(store.getState().runtimeEnvironments).toEqual([])

      await store.getState().hydrateRuntimeEnvironmentStatuses()
      expect(list).toHaveBeenCalledTimes(2)
      expect(store.getState().runtimeEnvironmentCatalogHydrated).toBe(true)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('both settles and hydrates the catalog on a successful read', async () => {
    const list = vi.fn().mockResolvedValue([])
    stubRuntimeEnvironmentApi({ getStatus: vi.fn(), list })
    const store = createSliceStore()

    await store.getState().hydrateRuntimeEnvironmentStatuses()

    expect(store.getState().runtimeEnvironmentCatalogSettled).toBe(true)
    expect(store.getState().runtimeEnvironmentCatalogHydrated).toBe(true)
  })
})
