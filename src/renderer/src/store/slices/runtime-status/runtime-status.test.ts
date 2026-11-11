import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { toast } from 'sonner'
import type { RuntimeStatus } from '../../../../../shared/runtime-session-contracts'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { createCompatibleRuntimeStatusResponse } from '../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { clearRuntimeEnvironmentConnectionGenerations as clearRuntimeEnvironmentConnectionGenerationsForTests } from './runtime-status-connection-generation'
import { createRuntimeStatusSlice } from './create-runtime-status-slice'
import type { RuntimeStatusSlice } from './runtime-status-types'
import '@/runtime/hosts/observations/provider-runtime-context'
import '../../../../../shared/workspace-creator-visibility'
import { stubRuntimeEnvironmentBridge } from '../../../runtime/rpc/testing/runtime-environment-bridge-fixture'

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
  stubRuntimeEnvironmentBridge({ getStatus, list })
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
    expect(vi.mocked(toast.warning).mock.calls.every((call) => call[1]?.id === toastId)).toBe(true)
  })

  it('drops a stale success refresh after the same environment is re-paired', async () => {
    const probe = deferred<ReturnType<typeof createCompatibleRuntimeStatusResponse>>()
    const getStatus = vi.fn().mockReturnValue(probe.promise)
    stubRuntimeEnvironmentApi({ getStatus })
    const store = createSliceStore()
    store.getState().setRuntimeEnvironments([makeEnvironment({ pairingRevision: 1 })])

    const refresh = store.getState().refreshRuntimeEnvironmentStatus('env-a')
    store.getState().setRuntimeEnvironments([makeEnvironment({ pairingRevision: 2 })])
    probe.resolve(createCompatibleRuntimeStatusResponse('runtime-old'))

    await expect(refresh).resolves.toBe(false)
    expect(store.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
  })

  it('drops a stale failure refresh after the same environment is re-paired', async () => {
    const probe = deferred<ReturnType<typeof createCompatibleRuntimeStatusResponse>>()
    const getStatus = vi.fn().mockReturnValue(probe.promise)
    stubRuntimeEnvironmentApi({ getStatus })
    const store = createSliceStore()
    store.getState().setRuntimeEnvironments([makeEnvironment({ pairingRevision: 1 })])

    const refresh = store.getState().refreshRuntimeEnvironmentStatus('env-a')
    store.getState().setRuntimeEnvironments([makeEnvironment({ pairingRevision: 2 })])
    probe.reject(new Error('old connection closed'))

    await expect(refresh).resolves.toBe(false)
    expect(store.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
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
    stubRuntimeEnvironmentBridge({ getStatus, call })
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
    // Settings Connect publishes reachable status before reuse-flagged repo.list; clear stale failure so that read re-probes.
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
    stubRuntimeEnvironmentBridge({ call })
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
    // Null status proves no recovery; fanout must keep sharing the cached compatibility failure.
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
    stubRuntimeEnvironmentBridge({ call })
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

  it('preserves successful reachability when reading its snapshot fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubRuntimeEnvironmentBridge({
      getStatus: vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a')),
      getStatusSnapshots: vi.fn().mockRejectedValue(new Error('IPC read failed'))
    })
    try {
      const store = createSliceStore()
      expect(await store.getState().refreshRuntimeEnvironmentStatus('env-a')).toBe(true)
      expect(store.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
      expect(log).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
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
    const first = store.getState().hydrateRuntimeEnvironmentStatuses()
    const second = store.getState().hydrateRuntimeEnvironmentStatuses()
    expect(list).toHaveBeenCalledTimes(1)
    expect(getStatus).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2))
    const third = store.getState().hydrateRuntimeEnvironmentStatuses()

    probeA.resolve(createCompatibleRuntimeStatusResponse('runtime-a'))
    probeB.reject(new Error('offline'))
    await Promise.all([first, second, third])

    expect(list).toHaveBeenCalledTimes(1)
    expect(getStatus).toHaveBeenCalledTimes(2)
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.runtimeId).toBe(
      'runtime-a'
    )
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-b')?.status).toBeNull()
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

  // Failed catalog reads release skill discovery waiters without marking routing hydrated; empty stale state cannot prove no runtimes.
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
})
