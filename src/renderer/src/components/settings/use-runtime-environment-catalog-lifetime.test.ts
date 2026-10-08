// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { useRuntimeEnvironmentCatalog } from './use-runtime-environment-catalog'

const store = vi.hoisted(() => ({
  setRuntimeEnvironments: vi.fn(),
  readRuntimeHostStatusSnapshots: vi.fn<() => Promise<void>>(),
  toastError: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { error: store.toastError } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  unwrapRuntimeRpcResult: (response: RuntimeRpcResponse<RuntimeStatus>) => {
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result
  }
}))
vi.mock('@/runtime/runtime-status-probe-diagnostics', () => ({
  extractRuntimeTransportDiagnostics: () => undefined
}))

function environment(id: string, source?: 'ephemeral-vm'): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: id,
    source,
    preferredEndpointId: id,
    endpoints: [{ id, kind: 'websocket', label: 'Fake', endpoint: 'ws://127.0.0.1:1' }]
  }
}

function installBridge() {
  const list = vi.fn<() => Promise<PublicKnownRuntimeEnvironment[]>>()
  const getStatus = vi.fn<() => Promise<RuntimeRpcResponse<RuntimeStatus>>>()
  getStatus.mockResolvedValue(createCompatibleRuntimeStatusResponse())
  vi.stubGlobal('api', { runtimeEnvironments: { list, getStatus } })
  return { list, getStatus }
}

function verifiedStatus(): RuntimeStatus {
  const response = createCompatibleRuntimeStatusResponse('verified')
  if (!response.ok) {
    throw new Error('Expected a successful runtime status fixture')
  }
  return response.result
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  store.readRuntimeHostStatusSnapshots.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('runtime environment catalog pane lifetime', () => {
  it('keeps a late catalog update without starting probes after close', async () => {
    const api = installBridge()
    const list = Promise.withResolvers<PublicKnownRuntimeEnvironment[]>()
    const environments = Array.from({ length: 40 }, (_, index) => environment(`host-${index}`))
    api.list.mockReturnValue(list.promise)
    const { unmount } = renderHook(() => useRuntimeEnvironmentCatalog())

    unmount()
    await act(async () => list.resolve(environments))

    expect(store.setRuntimeEnvironments).toHaveBeenCalledExactlyOnceWith(environments)
    expect(api.getStatus).not.toHaveBeenCalled()
    expect(store.readRuntimeHostStatusSnapshots).not.toHaveBeenCalled()
  })

  it('still reconciles a mutation catalog reload invoked after close', async () => {
    const api = installBridge()
    const environments = [environment('remaining')]
    api.list.mockResolvedValueOnce([]).mockResolvedValueOnce(environments)
    const { result, unmount } = renderHook(() => useRuntimeEnvironmentCatalog())
    await act(async () => undefined)
    const reloadAfterMutation = result.current.loadEnvironments
    unmount()
    store.setRuntimeEnvironments.mockClear()

    await reloadAfterMutation()

    expect(api.list).toHaveBeenCalledTimes(2)
    expect(store.setRuntimeEnvironments).toHaveBeenCalledExactlyOnceWith(environments)
    expect(api.getStatus).not.toHaveBeenCalled()
  })

  it('does not start sibling probes after a verified status wait outlives the pane', async () => {
    const api = installBridge()
    api.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([environment('verified'), environment('other')])
    const { result, unmount } = renderHook(() => useRuntimeEnvironmentCatalog())
    await act(async () => undefined)
    const snapshot = Promise.withResolvers<void>()
    store.readRuntimeHostStatusSnapshots.mockReturnValueOnce(snapshot.promise)
    let reload: Promise<void> | undefined
    await act(async () => {
      reload = result.current.loadEnvironments({
        environmentId: 'verified',
        runtimeStatus: verifiedStatus()
      })
    })
    expect(store.readRuntimeHostStatusSnapshots).toHaveBeenCalledOnce()
    unmount()

    await act(async () => {
      snapshot.resolve()
      await reload
    })

    expect(api.getStatus).not.toHaveBeenCalled()
    expect(store.readRuntimeHostStatusSnapshots).toHaveBeenCalledOnce()
  })

  it('preserves active probing and skips verified and ephemeral servers', async () => {
    const api = installBridge()
    const environments = [
      environment('verified'),
      environment('other'),
      environment('ephemeral', 'ephemeral-vm')
    ]
    api.list.mockResolvedValueOnce([]).mockResolvedValueOnce(environments)
    const { result } = renderHook(() => useRuntimeEnvironmentCatalog())
    await act(async () => undefined)

    await act(async () => {
      await result.current.loadEnvironments({
        environmentId: 'verified',
        runtimeStatus: verifiedStatus()
      })
    })

    expect(api.getStatus).toHaveBeenCalledExactlyOnceWith({
      selector: 'other',
      timeoutMs: 10_000
    })
    // Shared status is synchronized; coalescing those reads is not a regression.
    expect(store.readRuntimeHostStatusSnapshots).toHaveBeenCalled()
    expect(result.current.environments).toEqual(environments.slice(0, 2))
    expect(result.current.detailsByEnvironmentId.verified.status).toBe('ready')
    expect(result.current.detailsByEnvironmentId.other.status).toBe('ready')
    expect(result.current.isLoading).toBe(false)
  })

  it('allows an already started probe to synchronize shared status after close', async () => {
    const api = installBridge()
    const status = Promise.withResolvers<RuntimeRpcResponse<RuntimeStatus>>()
    api.list.mockResolvedValue([environment('started')])
    api.getStatus.mockReturnValue(status.promise)
    const { unmount } = renderHook(() => useRuntimeEnvironmentCatalog())
    await act(async () => undefined)
    expect(api.getStatus).toHaveBeenCalledOnce()
    unmount()

    await act(async () => status.resolve(createCompatibleRuntimeStatusResponse()))

    expect(store.readRuntimeHostStatusSnapshots).toHaveBeenCalledOnce()
  })

  it("probes again on reopen instead of inheriting the closed pane's suppression", async () => {
    const api = installBridge()
    const firstList = Promise.withResolvers<PublicKnownRuntimeEnvironment[]>()
    const environments = [environment('host-a'), environment('host-b')]
    api.list.mockReturnValueOnce(firstList.promise).mockResolvedValue(environments)
    const closed = renderHook(() => useRuntimeEnvironmentCatalog())

    closed.unmount()
    await act(async () => firstList.resolve(environments))

    expect(api.getStatus).not.toHaveBeenCalled()
    // A probe that never ran is not evidence a host is unreachable.
    expect(Object.values(closed.result.current.detailsByEnvironmentId)).not.toContainEqual(
      expect.objectContaining({ status: 'error' })
    )

    const status = Promise.withResolvers<RuntimeRpcResponse<RuntimeStatus>>()
    api.getStatus.mockReturnValue(status.promise)
    const reopened = renderHook(() => useRuntimeEnvironmentCatalog())
    await flush()

    expect(api.getStatus).toHaveBeenCalledTimes(2)
    expect(
      Object.values(reopened.result.current.detailsByEnvironmentId).map((details) => details.status)
    ).toEqual(['loading', 'loading'])

    await act(async () => status.resolve(createCompatibleRuntimeStatusResponse()))
    await flush()

    expect(reopened.result.current.environments).toEqual(environments)
    expect(reopened.result.current.detailsByEnvironmentId['host-a'].status).toBe('ready')
    expect(reopened.result.current.detailsByEnvironmentId['host-b'].status).toBe('ready')
    expect(reopened.result.current.isLoading).toBe(false)
  })

  it('still finishes the initial load under StrictMode double-invoked effects', async () => {
    const api = installBridge()
    api.list.mockResolvedValue([environment('host-a')])

    const { result } = renderHook(() => useRuntimeEnvironmentCatalog(), { wrapper: StrictMode })
    await flush()

    // React's simulated unmount/remount reuses the mounted ref; suppression must not stick.
    expect(api.getStatus).toHaveBeenCalled()
    expect(result.current.detailsByEnvironmentId['host-a'].status).toBe('ready')
    expect(result.current.isLoading).toBe(false)
  })

  it('does not report a late catalog error after close', async () => {
    const api = installBridge()
    const list = Promise.withResolvers<PublicKnownRuntimeEnvironment[]>()
    api.list.mockReturnValue(list.promise)
    const { unmount } = renderHook(() => useRuntimeEnvironmentCatalog())
    unmount()

    await act(async () => list.reject(new Error('controlled unavailable response')))

    expect(store.toastError).not.toHaveBeenCalled()
    expect(api.getStatus).not.toHaveBeenCalled()
  })
})
