import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { createCompatibleRuntimeStatusResponse } from '../../runtime/runtime-compatibility-test-fixture'
import {
  callRuntimeRpc,
  clearRuntimeCompatibilityCacheForTests
} from '../../runtime/runtime-rpc-client'
import { createRuntimeStatusSlice, type RuntimeStatusSlice } from './runtime-status'

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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runtime-status slice', () => {
  it('starts with an empty map', () => {
    const store = createSliceStore()
    expect(store.getState().runtimeEnvironments).toEqual([])
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
    expect(store.getState().runtimeStatusByEnvironmentId.has('keep')).toBe(true)
    expect(store.getState().runtimeStatusByEnvironmentId.has('drop')).toBe(false)
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
    expect(map.get('env-a')).toEqual({ status: null, checkedAt: 5 })
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
})
