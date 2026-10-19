// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { LinearConnectionStatus } from '../../../../shared/linear/workspace-types'
import { useLinearSourceConnection } from './use-linear-source-connection'

const mocks = vi.hoisted(() => ({ linearStatus: vi.fn() }))
vi.mock('@/runtime/runtime-linear-client', () => mocks)
type ConnectionState = {
  runtimeStatusByEnvironmentId: Map<
    string,
    { connectionGeneration?: number; hostContactEpoch?: number }
  >
  linearStatus: LinearConnectionStatus
  linearStatusContextKey: string | null
}
const store = createStore<ConnectionState>(() => ({
  runtimeStatusByEnvironmentId: new Map(),
  linearStatus: { connected: false, viewer: null },
  linearStatusContextKey: null
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: ConnectionState) => unknown) => useStore(store, selector)
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

describe('useLinearSourceConnection', () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    store.setState({
      runtimeStatusByEnvironmentId: new Map(),
      linearStatus: status(false),
      linearStatusContextKey: null
    })
  })

  it('reads the explicit source host independently of focused runtime status', async () => {
    const source = context('runtime:source-host')
    mocks.linearStatus.mockResolvedValue(status(true))
    const { result } = renderHook(() =>
      useLinearSourceConnection({ enabled: true, sourceContext: source })
    )
    expect(result.current).toEqual({ status: null, loaded: false })
    await waitFor(() => expect(result.current.status?.connected).toBe(true))
    expect(result.current.loaded).toBe(true)
    expect(mocks.linearStatus).toHaveBeenCalledWith(source)
  })

  it('does not add reads to existing consumers without an explicit source', async () => {
    renderHook(() => useLinearSourceConnection({ enabled: true, sourceContext: null }))
    renderHook(() => useLinearSourceConnection({ enabled: false, sourceContext: context('local') }))
    await act(async () => {})
    expect(mocks.linearStatus).not.toHaveBeenCalled()
  })

  it('keeps equivalent source objects from refetching on every renderer update', async () => {
    mocks.linearStatus.mockResolvedValue(status(true))
    const { result, rerender } = renderHook(() =>
      useLinearSourceConnection({ enabled: true, sourceContext: context('local') })
    )
    await waitFor(() => expect(result.current.loaded).toBe(true))
    const loaded = result.current
    rerender()
    expect(result.current).toBe(loaded)
    expect(mocks.linearStatus).toHaveBeenCalledTimes(1)
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
    expect(result.current).toEqual({ status: null, loaded: false })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => {
      resolveOld(status(true))
      await oldRead
    })
    expect(result.current.status?.connected).toBe(false)
  })

  it('settles failed status reads as disconnected', async () => {
    mocks.linearStatus.mockRejectedValue(new Error('Host unavailable'))
    const { result } = renderHook(() =>
      useLinearSourceConnection({ enabled: true, sourceContext: context('runtime:offline') })
    )
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.status?.connected).toBe(false)
  })

  it.each(['hostContactEpoch', 'connectionGeneration'] as const)(
    'retries a failed saved-host read when %s advances without changing focus',
    async (revision) => {
      mocks.linearStatus.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(status(true))
      const { result } = renderHook(() =>
        useLinearSourceConnection({ enabled: true, sourceContext: context('runtime:saved-host') })
      )
      await waitFor(() => expect(result.current.status?.connected).toBe(false))
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

  it('refreshes matching-host workspace changes without borrowing another host status', async () => {
    mocks.linearStatus.mockResolvedValue({ ...status(true), selectedWorkspaceId: 'original' })
    const { result } = renderHook(() =>
      useLinearSourceConnection({ enabled: true, sourceContext: context('runtime:saved-host') })
    )
    await waitFor(() => expect(result.current.loaded).toBe(true))
    act(() => {
      store.setState({
        linearStatusContextKey: 'runtime:other-host#0',
        linearStatus: { ...status(true), selectedWorkspaceId: 'other' },
        runtimeStatusByEnvironmentId: new Map([['other-host', { hostContactEpoch: 1 }]])
      })
    })
    expect(result.current.status?.selectedWorkspaceId).toBe('original')
    expect(mocks.linearStatus).toHaveBeenCalledTimes(1)
    mocks.linearStatus.mockResolvedValue({ ...status(true), selectedWorkspaceId: 'updated' })
    act(() => {
      store.setState({
        linearStatusContextKey: 'runtime:saved-host#0',
        linearStatus: { ...status(true), selectedWorkspaceId: 'updated' }
      })
    })
    await waitFor(() => expect(result.current.status?.selectedWorkspaceId).toBe('updated'))
    expect(mocks.linearStatus).toHaveBeenCalledTimes(2)
  })
})
