// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { LinearConnectionStatus } from '../../../../shared/linear/workspace-types'

import { useLinearSourceConnection } from './use-linear-source-connection'

const mocks = vi.hoisted(() => ({ linearStatus: vi.fn() }))
vi.mock('@/runtime/linear/runtime-linear-client', () => mocks)
type ConnectionState = {
  runtimeStatusByEnvironmentId: Map<
    string,
    { connectionGeneration?: number; hostContactEpoch?: number }
  >
  linearStatus: LinearConnectionStatus
  linearStatusObserved: boolean
  linearStatusContextKey: string | null
}
const store = createStore<ConnectionState>(() => ({
  runtimeStatusByEnvironmentId: new Map(),
  linearStatus: { connected: false, viewer: null },
  linearStatusObserved: false,
  linearStatusContextKey: null
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: ConnectionState) => unknown) => useStore(store, selector),
    {
      getState: () => store.getState(),
      subscribe: (...args: Parameters<typeof store.subscribe>) => store.subscribe(...args)
    }
  )
}))

function context(hostId: TaskSourceContext['hostId']): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'linear',
    projectId: 'project-1',
    hostId,
    repoId: 'repo-1',
    accountLabel: null,
    providerIdentity: null
  }
}

function status(connected: boolean): LinearConnectionStatus {
  return { connected, viewer: null }
}

afterEach(cleanup)

describe('useLinearSourceConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.setState({
      runtimeStatusByEnvironmentId: new Map(),
      linearStatus: status(false),
      linearStatusObserved: false,
      linearStatusContextKey: null
    })
  })

  it('hides old status immediately and rejects late responses after a host switch', async () => {
    let resolveOld: (value: LinearConnectionStatus) => void = () => {}
    const oldRead = new Promise<LinearConnectionStatus>((resolve) => {
      resolveOld = resolve
    })
    mocks.linearStatus.mockReturnValueOnce(oldRead).mockResolvedValueOnce(status(false))
    const { result, rerender } = renderHook(
      ({ source }) => useLinearSourceConnection({ enabled: true, sourceContext: source }),
      { initialProps: { source: context('local') } }
    )
    rerender({ source: context('runtime:new-host') })
    expect(result.current).toEqual({ status: null, loaded: false, refresh: expect.any(Function) })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => {
      resolveOld(status(true))
      await oldRead
    })
    expect(result.current.status?.connected).toBe(false)
  })

  it.each(['hostContactEpoch', 'connectionGeneration'] as const)(
    'retries a failed saved-host read when %s advances without changing focus',
    async (revision) => {
      mocks.linearStatus.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(status(true))
      const { result } = renderHook(() =>
        useLinearSourceConnection({ enabled: true, sourceContext: context('runtime:saved-host') })
      )
      await waitFor(() => expect(result.current.loaded).toBe(true))
      act(() => {
        store.setState({
          runtimeStatusByEnvironmentId: new Map([['saved-host', { [revision]: 1 }]])
        })
      })
      await waitFor(() => expect(result.current.status?.connected).toBe(true))
      expect(mocks.linearStatus).toHaveBeenCalledTimes(2)
    }
  )

  it('rejects an earlier status read after the same host reconnects', async () => {
    let resolveOld: (value: LinearConnectionStatus) => void = () => {}
    const oldRead = new Promise<LinearConnectionStatus>((resolve) => {
      resolveOld = resolve
    })
    mocks.linearStatus.mockReturnValueOnce(oldRead).mockResolvedValueOnce(status(true))
    const { result } = renderHook(() =>
      useLinearSourceConnection({ enabled: true, sourceContext: context('runtime:saved-host') })
    )
    act(() => {
      store.setState({
        runtimeStatusByEnvironmentId: new Map([['saved-host', { hostContactEpoch: 1 }]])
      })
    })
    await waitFor(() => expect(result.current.status?.connected).toBe(true))
    await act(async () => {
      resolveOld(status(false))
      await oldRead
    })
    expect(result.current.status?.connected).toBe(true)
  })
})

// Each update has its own act turn: upstream operation counts are separate from renders.
it('retires held source requests with matching truth and isolates unrelated consumers', async () => {
  const old = Promise.withResolvers<LinearConnectionStatus>()
  mocks.linearStatus.mockReset()
  store.setState({
    linearStatusObserved: false,
    linearStatusContextKey: null,
    runtimeStatusByEnvironmentId: new Map()
  })
  mocks.linearStatus.mockReturnValueOnce(old.promise).mockResolvedValue(status(true))
  let renders = 0
  const { result, unmount } = renderHook(() => {
    renders += 1
    return useLinearSourceConnection({ enabled: true, sourceContext: context('runtime:source') })
  })
  const initial = renders
  act(() =>
    store.setState({
      linearStatusObserved: true,
      linearStatusContextKey: 'runtime:foreign#0',
      linearStatus: status(true)
    })
  )
  expect(renders).toBe(initial)
  act(() =>
    store.setState({ linearStatusContextKey: 'runtime:source#0', linearStatus: status(false) })
  )
  expect(result.current.status?.connected).toBe(false)
  expect(renders).toBeGreaterThan(initial)
  await act(async () => {
    old.resolve(status(true))
    await old.promise
  })
  expect(result.current.status?.connected).toBe(false)
  mocks.linearStatus.mockRejectedValue(new Error('unreachable'))
  await act(async () => {
    await result.current.refresh()
  })
  expect(result.current.status?.connected).toBe(false)
  expect(
    mocks.linearStatus.mock.calls.every(([source]) => source.hostId === 'runtime:source')
  ).toBe(true)
  const beforeForeign = renders
  const beforeForeignCalls = mocks.linearStatus.mock.calls.length
  act(() =>
    store.setState({ linearStatusContextKey: 'runtime:foreign#0', linearStatus: status(true) })
  )
  expect(renders).toBe(beforeForeign)
  expect(mocks.linearStatus).toHaveBeenCalledTimes(beforeForeignCalls)
  const calls = mocks.linearStatus.mock.calls.length
  const refresh = result.current.refresh
  unmount()
  await refresh()
  expect(mocks.linearStatus).toHaveBeenCalledTimes(calls)
})
