// @vitest-environment happy-dom

import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type {
  LinearCollectionResult,
  LinearConnectionStatus
} from '../../../../shared/linear/workspace-types'
import { openLinearIssueRead } from '@/store/slices/linear/linear-issue-publication'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import { useLinearSourceConnection } from './use-linear-source-connection'

const mocks = vi.hoisted(() => ({ linearStatus: vi.fn() }))
vi.mock('@/runtime/runtime-linear-client', () => mocks)
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

  it('reads the explicit source host independently of focused runtime status', async () => {
    const source = context('runtime:source-host')
    mocks.linearStatus.mockResolvedValue(status(true))
    const { result } = renderHook(() =>
      useLinearSourceConnection({ enabled: true, sourceContext: source })
    )
    expect(result.current).toEqual({ status: null, loaded: false, refresh: expect.any(Function) })
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

  it('keeps the loaded status when the selected repo changes on the same host', async () => {
    mocks.linearStatus.mockResolvedValue(status(true))
    const { result, rerender } = renderHook(
      ({ source }) => useLinearSourceConnection({ enabled: true, sourceContext: source }),
      { initialProps: { source: context('runtime:host') } }
    )
    await waitFor(() => expect(result.current.loaded).toBe(true))
    rerender({ source: { ...context('runtime:host'), projectId: 'project-2', repoId: 'repo-2' } })
    expect(result.current).toEqual({
      status: status(true),
      loaded: true,
      refresh: expect.any(Function)
    })
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
    expect(result.current).toEqual({ status: null, loaded: false, refresh: expect.any(Function) })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => {
      resolveOld(status(true))
      await oldRead
    })
    expect(result.current.status?.connected).toBe(false)
  })

  it('settles cold failed status reads as unknown', async () => {
    mocks.linearStatus.mockRejectedValue(new Error('Host unavailable'))
    const { result } = renderHook(() =>
      useLinearSourceConnection({ enabled: true, sourceContext: context('runtime:offline') })
    )
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.status).toBeNull()
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
        linearStatusObserved: true,
        linearStatusContextKey: 'runtime:saved-host#0',
        linearStatus: { ...status(true), selectedWorkspaceId: 'updated' }
      })
    })
    // Same-host re-read keeps the last status so the Linear tab stays selected.
    expect(result.current).toMatchObject({
      loaded: true,
      status: { selectedWorkspaceId: 'updated' }
    })
    await waitFor(() => expect(result.current.status?.selectedWorkspaceId).toBe('updated'))
    expect(mocks.linearStatus).toHaveBeenCalledTimes(1)
  })
})

it('retains a matching source success on outage but actual matching false wins without redundant probe', async () => {
  store.setState({
    linearStatus: status(false),
    linearStatusObserved: false,
    linearStatusContextKey: null,
    runtimeStatusByEnvironmentId: new Map()
  })
  mocks.linearStatus.mockReset()
  mocks.linearStatus.mockResolvedValueOnce(status(true)).mockRejectedValue(new Error('offline'))
  const { result } = renderHook(() =>
    useLinearSourceConnection({ enabled: true, sourceContext: context('runtime:saved-host') })
  )
  await waitFor(() => expect(result.current.status?.connected).toBe(true))
  act(() =>
    store.setState({
      runtimeStatusByEnvironmentId: new Map([['saved-host', { hostContactEpoch: 1 }]])
    })
  )
  await waitFor(() => expect(mocks.linearStatus).toHaveBeenCalledTimes(2))
  await act(async () => {})
  expect(result.current.status?.connected).toBe(true)
  const cached: LinearCollectionResult<LinearIssue> = {
    items: [],
    errors: [
      {
        workspaceId: 'old-W',
        type: 'auth',
        message: 'Linear authentication expired for this workspace.'
      }
    ]
  }
  const read = openLinearIssueRead({
    scope: getLinearSourceScope(context('runtime:saved-host')),
    seed: cached,
    cached,
    dispatch: async () => {
      throw new Error('ordinary query outage')
    },
    publish: () => {},
    isCurrent: () => true,
    remove: () => {}
  })
  const lease = read.acquire()
  read.force()
  const view = await lease.waitForCurrentTerminal()
  expect(view).toMatchObject({ kind: 'error', data: cached })
  await act(async () => {
    await result.current.refresh({ view, workspaceId: 'all', status: status(true) })
  })
  lease.release()
  expect(mocks.linearStatus).toHaveBeenCalledTimes(2)
  expect(result.current.status?.connected).toBe(true)
  act(() =>
    store.setState({
      linearStatusContextKey: 'runtime:saved-host#0',
      linearStatusObserved: true,
      linearStatus: status(false)
    })
  )
  expect(result.current.status?.connected).toBe(false)
  expect(mocks.linearStatus).toHaveBeenCalledTimes(2)
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

it.each([2, 20])(
  'bounds actual runtime-contact status work for %i mounted source consumers',
  async (N) => {
    mocks.linearStatus.mockReset()
    mocks.linearStatus.mockResolvedValue(status(true))
    store.setState({
      linearStatusObserved: false,
      linearStatusContextKey: null,
      runtimeStatusByEnvironmentId: new Map()
    })
    function Source() {
      const connection = useLinearSourceConnection({
        enabled: true,
        sourceContext: context('runtime:scaling')
      })
      return <span>{connection.loaded ? 'ready' : 'pending'}</span>
    }
    const mounted = render(
      <>
        {Array.from({ length: N }, (_, index) => (
          <Source key={index} />
        ))}
      </>
    )
    await waitFor(() => expect(screen.getAllByText('ready')).toHaveLength(N))
    expect(mocks.linearStatus).toHaveBeenCalledTimes(N)
    await act(async () =>
      store.setState({
        runtimeStatusByEnvironmentId: new Map([['scaling', { hostContactEpoch: 1 }]])
      })
    )
    expect(mocks.linearStatus).toHaveBeenCalledTimes(2 * N)
    const calls = mocks.linearStatus.mock.calls.length
    mounted.unmount()
    act(() =>
      store.setState({
        runtimeStatusByEnvironmentId: new Map([['scaling', { hostContactEpoch: 2 }]])
      })
    )
    expect(mocks.linearStatus).toHaveBeenCalledTimes(calls)
  }
)
