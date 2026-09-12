// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { useRuntimeEnvironmentReconciliation } from './use-runtime-environment-reconciliation'

const mocks = vi.hoisted(() => ({ list: vi.fn(), reconcile: vi.fn(), hydrate: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setRuntimeEnvironments: mocks.hydrate }) }
}))
const request = { action: 'activate' as const, environmentId: 'old', requestId: 'stable-request' }
const rows = (stage: 'prepared' | 'catalog-active'): PublicKnownRuntimeEnvironment[] =>
  ['canonical', 'old', 'unrelated'].map((id) => ({
    id,
    name: id,
    runtimeId: id === 'unrelated' ? 'other-host' : 'same-host',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    preferredEndpointId: 'endpoint',
    endpoints: [{ id: 'endpoint', kind: 'websocket', label: 'Direct', endpoint: 'wss://host' }],
    ...(id === 'unrelated'
      ? {}
      : {
          reconciliation: {
            version: 1 as const,
            stage,
            requestId: request.requestId,
            canonicalEnvironmentId: 'canonical',
            runtimeId: 'same-host',
            preparedAt: 1,
            registrations: ['canonical', 'old'].map((environmentId) => ({
              environmentId,
              authorityDigest: 'a'.repeat(64)
            }))
          }
        })
  }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('api', { runtimeEnvironments: { list: mocks.list, reconcile: mocks.reconcile } })
  mocks.list.mockResolvedValue(rows('prepared'))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('requires a loaded registry before mutation and hydrates every original row', async () => {
  const { result } = renderHook(useRuntimeEnvironmentReconciliation)
  await act(() => result.current.reconcile(request))
  expect(mocks.reconcile).not.toHaveBeenCalled()
  await act(() => result.current.refresh())
  expect(result.current.snapshotFresh).toBe(true)
  mocks.list.mockResolvedValue(rows('catalog-active'))
  await act(() => result.current.reconcile(request))
  expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(request)
  expect(result.current.environments).toEqual(rows('catalog-active'))
  expect(mocks.hydrate).toHaveBeenLastCalledWith(rows('catalog-active'))
})

it('rereads after a lost mutation reply and exposes the saved active stage alongside the error', async () => {
  const { result } = renderHook(useRuntimeEnvironmentReconciliation)
  await act(() => result.current.refresh())
  mocks.reconcile.mockRejectedValue(new Error('reply lost'))
  mocks.list.mockResolvedValue(rows('catalog-active'))
  await act(() => result.current.reconcile(request))
  expect(result.current.requestError).toBe('reply lost')
  expect(result.current.snapshotFresh).toBe(true)
  expect(result.current.environments).toEqual(rows('catalog-active'))
  expect(result.current.refreshError).toBeNull()
})

it('blocks further mutation after a failed reread until an explicit refresh succeeds', async () => {
  const { result } = renderHook(useRuntimeEnvironmentReconciliation)
  await act(() => result.current.refresh())
  mocks.list.mockRejectedValue(new Error('profile unavailable'))
  await act(() => result.current.reconcile(request))
  expect(result.current.snapshotFresh).toBe(false)
  expect(result.current.refreshError).toBe('profile unavailable')
  expect(result.current.requestError).toBeNull()
  await act(() => result.current.reconcile(request))
  expect(mocks.reconcile).toHaveBeenCalledTimes(1)
  mocks.list.mockResolvedValue(rows('catalog-active'))
  await act(() => result.current.refresh())
  expect(result.current.snapshotFresh).toBe(true)
  expect(result.current.refreshError).toBeNull()
})

it('rejects duplicate dispatch and refresh while a mutation is in flight', async () => {
  const { result } = renderHook(useRuntimeEnvironmentReconciliation)
  await act(() => result.current.refresh())
  let finish!: () => void
  mocks.reconcile.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
  let pending!: Promise<void>
  act(() => {
    pending = result.current.reconcile(request)
  })
  await act(async () => {
    await result.current.reconcile(request)
    await result.current.refresh()
  })
  expect(mocks.reconcile).toHaveBeenCalledTimes(1)
  expect(mocks.list).toHaveBeenCalledTimes(1)
  expect(result.current.busy).toBe(true)
  await act(async () => {
    finish()
    await pending
  })
  expect(result.current.busy).toBe(false)
  expect(mocks.list).toHaveBeenCalledTimes(2)
})
