// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createStore } from 'zustand/vanilla'
import { createClaudeUsageSlice } from './usage-provider-slices'
import { useUsageObservation } from './use-usage-observation'
import type {
  BackendConnectionListener,
  BackendConnectionDetail
} from '../../../../../shared/backend-service-contract'
import type { AppState } from '../../types'
import type { ClaudeUsageScanState } from '../../../../../shared/claude-usage-types'

const scanState: ClaudeUsageScanState = {
  enabled: true,
  isScanning: false,
  lastScanStartedAt: null,
  lastScanCompletedAt: 1,
  lastScanError: null,
  hasAnyClaudeData: true
}
const snapshot = {
  scanState,
  summary: { turns: 1, inputTokens: 123 },
  daily: [],
  modelBreakdown: [],
  projectBreakdown: [],
  recentSessions: []
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture() {
  const listeners = new Set<BackendConnectionListener>()
  let status = { connected: false, unavailable: false }
  const api = {
    onConnectionChanged: (listener: BackendConnectionListener) => {
      listeners.add(listener)
      listener(status.connected, { initial: true, unavailable: status.unavailable })
      return () => {
        listeners.delete(listener)
      }
    },
    setEnabled: vi.fn(async ({ enabled }: { enabled: boolean }) => ({ ...scanState, enabled })),
    getScanState: vi.fn(async () => scanState),
    getSnapshot: vi.fn(async (_selection: { scope: string; range: string }) => snapshot),
    refresh: vi.fn(async (_options?: { force?: boolean }) => scanState)
  }
  vi.stubGlobal('api', { claudeUsage: api })
  const store = createStore<AppState>()((...args) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture uses only this production slice's public state/actions.
    return createClaudeUsageSlice(...args) as AppState
  })
  return {
    store,
    api,
    notify: (connected: boolean, detail?: BackendConnectionDetail) => {
      status = { connected, unavailable: detail?.unavailable === true }
      for (const listener of listeners) {
        listener(connected, detail)
      }
    }
  }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each([1, 10])(
  'hydrates only %i mounted outputs and does no hidden reconnect work',
  async (count) => {
    const { api, notify } = fixture()
    const stores = Array.from({ length: count }, () =>
      createStore<AppState>()((...args) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the usage slice is exercised.
        return createClaudeUsageSlice(...args) as AppState
      })
    )
    const hooks = stores.map((store) =>
      renderHook(() => useUsageObservation(store.getState().observeClaudeUsage))
    )
    await act(async () => {
      await Promise.all(stores.map((store) => store.getState().fetchClaudeUsage()))
    })
    api.getScanState.mockClear()
    api.getSnapshot.mockClear()
    api.refresh.mockClear()
    await act(async () => {
      notify(false)
      notify(true)
    })
    expect(api.getScanState).toHaveBeenCalledTimes(count)
    expect(api.getSnapshot).toHaveBeenCalledTimes(count)
    expect(api.refresh).not.toHaveBeenCalled()
    expect(stores[0].getState().claudeUsageSummary).toMatchObject({ inputTokens: 123 })
    for (const hook of hooks) {
      hook.unmount()
    }
    api.getScanState.mockClear()
    api.getSnapshot.mockClear()
    await act(async () => {
      notify(false)
      notify(true)
    })
    expect(api.getScanState).not.toHaveBeenCalled()
    expect(api.getSnapshot).not.toHaveBeenCalled()
  }
)

it.each([1, 10])('drops lost queued force after %i outputs unmount', async (count) => {
  const { api, notify } = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const refresh = deferred<typeof scanState>()
  api.refresh.mockReturnValue(refresh.promise)
  const stores = Array.from({ length: count }, () =>
    createStore<AppState>()((...args) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the usage slice is exercised.
      return createClaudeUsageSlice(...args) as AppState
    })
  )
  const hooks = stores.map((store) =>
    renderHook(() => useUsageObservation(store.getState().observeClaudeUsage))
  )
  await act(async () => {})
  expect(api.refresh).toHaveBeenCalledTimes(count)
  const forced = stores.map((store) => store.getState().refreshClaudeUsage())
  for (const hook of hooks) {
    hook.unmount()
  }
  api.getScanState.mockClear()
  api.getSnapshot.mockClear()
  api.refresh.mockClear()
  await act(async () => {
    notify(false)
    refresh.reject(new Error('port closed'))
    await Promise.all(forced)
    notify(true)
  })
  expect(api.getScanState).not.toHaveBeenCalled()
  expect(api.getSnapshot).not.toHaveBeenCalled()
  expect(api.refresh).not.toHaveBeenCalled()
  expect(stores[0].getState().claudeUsageScanState?.isScanning).toBe(false)
})

it.each([false, true])(
  'preserves admitted work after unmount and same-connection failure=%s',
  async (fail) => {
    const { api, store } = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const refresh = deferred<typeof scanState>()
    api.refresh.mockReturnValueOnce(refresh.promise)
    const hook = renderHook(() => useUsageObservation(store.getState().observeClaudeUsage))
    await act(async () => {})
    expect(api.refresh).toHaveBeenCalledTimes(1)
    const forced = store.getState().refreshClaudeUsage()
    hook.unmount()
    if (fail) {
      refresh.reject(new Error('scan failed on the same connection'))
    } else {
      refresh.resolve(scanState)
    }
    await forced
    expect(api.refresh.mock.calls.map(([options]) => options?.force)).toEqual([false, true])
    expect(store.getState().claudeUsageSummary).toMatchObject({ inputTokens: 123 })
  }
)

it('retains fresh explicit intent after loss while the old call is rejecting', async () => {
  const { api, store, notify } = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const refresh = deferred<typeof scanState>()
  api.refresh.mockReturnValueOnce(refresh.promise)
  const hook = renderHook(() => useUsageObservation(store.getState().observeClaudeUsage))
  await act(async () => {})
  const oldForce = store.getState().refreshClaudeUsage()
  hook.unmount()
  notify(false)
  const fresh = store.getState().refreshClaudeUsage()
  refresh.reject(new Error('old port closed'))
  await Promise.all([oldForce, fresh])
  expect(api.refresh.mock.calls.map(([options]) => options?.force)).toEqual([false, true])
  expect(store.getState().claudeUsageSummary).toMatchObject({ inputTokens: 123 })
})

it('retains mounted recovery after the first state request fails', async () => {
  const { store, api, notify } = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  api.getScanState.mockRejectedValueOnce(new Error('first connection failed'))
  renderHook(() => useUsageObservation(store.getState().observeClaudeUsage))
  await act(async () => {
    await store.getState().fetchClaudeUsage()
  })
  expect(store.getState().claudeUsageScanState).toBeNull()
  await act(async () => {
    notify(true)
  })
  expect(store.getState().claudeUsageSummary).toMatchObject({ inputTokens: 123 })
  expect(api.refresh).not.toHaveBeenCalled()
})

it('joins the startup-ready signal and bounds selection storms while retaining a late force', async () => {
  const { store, api, notify } = fixture()
  const refresh = deferred<typeof scanState>()
  api.refresh.mockReturnValueOnce(refresh.promise)
  renderHook(() => useUsageObservation(store.getState().observeClaudeUsage))
  await act(async () => {
    notify(true)
  })
  expect(api.getScanState).toHaveBeenCalledTimes(1)
  const requests = Array.from({ length: 40 }, (_, i) =>
    store.getState().setClaudeUsageRange(i === 39 ? 'all' : '7d')
  )
  const forced = store.getState().refreshClaudeUsage()
  await act(async () => {
    refresh.resolve(scanState)
    await Promise.all([...requests, forced])
  })
  expect(api.refresh.mock.calls.map(([options]) => options?.force)).toEqual([false, true])
  expect(store.getState().claudeUsageRange).toBe('all')
  expect(api.getSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({ range: 'all' })
})

it.each([false, true])(
  'owns queued explicit refresh across ordinary failure=%s',
  async (failed) => {
    const { store, api } = fixture()
    const background = deferred<typeof scanState>()
    const forcedState = deferred<typeof scanState>()
    const forcedScan = deferred<typeof scanState>()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.getScanState.mockResolvedValueOnce(scanState).mockReturnValueOnce(forcedState.promise)
    api.refresh.mockReturnValueOnce(background.promise).mockReturnValueOnce(forcedScan.promise)
    const first = store.getState().fetchClaudeUsage()
    await vi.waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1))
    expect(store.getState().claudeUsageSummary).toMatchObject({ inputTokens: 123 })
    expect(store.getState().claudeUsageScanState?.isScanning).toBe(false)

    const forced = store.getState().refreshClaudeUsage()
    expect(store.getState().claudeUsageScanState?.isScanning).toBe(true)
    const busy: boolean[] = []
    const unsubscribe = store.subscribe((state) => {
      busy.push(state.claudeUsageScanState?.isScanning ?? false)
    })
    if (failed) {
      background.reject(new Error('Catalog unavailable'))
    } else {
      background.resolve(scanState)
    }
    await vi.waitFor(() => expect(api.getScanState).toHaveBeenCalledTimes(2))
    expect(store.getState().claudeUsageScanState?.isScanning).toBe(true)
    expect(busy.every(Boolean)).toBe(true)
    forcedState.resolve(scanState)
    await vi.waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(2))
    expect(busy.length).toBeGreaterThan(0)
    expect(busy.every(Boolean)).toBe(true)
    expect(store.getState().claudeUsageSummary).toMatchObject({ inputTokens: 123 })
    unsubscribe()
    forcedScan.resolve(scanState)
    await Promise.all([first, forced])
    expect(store.getState().claudeUsageScanState?.isScanning).toBe(false)
  }
)

it('shows first-load scanning without masking a reported scan on answered data', async () => {
  const { store, api } = fixture()
  const background = deferred<typeof scanState>()
  api.getSnapshot.mockResolvedValueOnce({
    ...snapshot,
    scanState: { ...scanState, lastScanCompletedAt: null, hasAnyClaudeData: false }
  })
  api.refresh.mockReturnValueOnce(background.promise)
  const first = store.getState().fetchClaudeUsage()
  await vi.waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1))
  expect(store.getState().claudeUsageScanState?.isScanning).toBe(true)
  background.resolve(scanState)
  await first
  expect(store.getState().claudeUsageScanState?.isScanning).toBe(false)

  const scanning = deferred<typeof scanState>()
  api.getScanState.mockResolvedValueOnce({ ...scanState, isScanning: true })
  api.getSnapshot.mockResolvedValueOnce({
    ...snapshot,
    scanState: { ...scanState, isScanning: true }
  })
  api.refresh.mockReturnValueOnce(scanning.promise)
  const next = store.getState().fetchClaudeUsage()
  await vi.waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(2))
  expect(store.getState().claudeUsageScanState?.isScanning).toBe(true)
  scanning.resolve(scanState)
  await next
})

it('does not publish an obsolete selection or swallow force after refresh has finished', async () => {
  const { store, api } = fixture()
  const projection = deferred<typeof snapshot>()
  api.getSnapshot.mockResolvedValueOnce(snapshot).mockReturnValueOnce(projection.promise)
  const first = store.getState().fetchClaudeUsage()
  await vi.waitFor(() => expect(api.getSnapshot).toHaveBeenCalledTimes(2))
  const selected = store.getState().setClaudeUsageRange('all')
  const forced = store.getState().refreshClaudeUsage()
  projection.resolve({ ...snapshot, summary: { turns: 2, inputTokens: 999 } })
  await Promise.all([first, selected, forced])
  expect(store.getState().claudeUsageSummary).toMatchObject({ inputTokens: 123 })
  expect(api.refresh.mock.calls.map(([options]) => options?.force)).toEqual([false, true])
  expect(api.getSnapshot.mock.calls.at(-1)?.[0]).toMatchObject({ range: 'all' })
})

it('shows lost Refresh through read-only recovery and clears it only after a successful explicit retry', async () => {
  const { api, store, notify } = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const stop = store.getState().observeClaudeUsage()
  await store.getState().fetchClaudeUsage()
  const held = deferred<typeof scanState>()
  api.refresh.mockReturnValueOnce(held.promise)
  const refresh = store.getState().refreshClaudeUsage()
  await vi.waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(2))
  notify(false)
  notify(false, { unavailable: true })
  held.reject(new Error('Usage disconnected'))
  await refresh
  expect(store.getState().claudeUsageFailure).toMatchObject({ terminal: true, refresh: true })
  expect(store.getState().claudeUsageScanState?.isScanning).toBe(false)
  api.refresh.mockClear()
  notify(true)
  await store.getState().fetchClaudeUsage()
  expect(api.refresh).not.toHaveBeenCalled()
  expect(store.getState().claudeUsageFailure).toMatchObject({ terminal: false, refresh: true })
  expect(store.getState().claudeUsageSummary).toMatchObject({ inputTokens: 123 })
  await store.getState().refreshClaudeUsage()
  expect(api.refresh.mock.calls.map(([options]) => options?.force)).toEqual([true])
  expect(store.getState().claudeUsageFailure).toBeNull()
  stop()
})

it.each([
  'skip',
  'scanning',
  'error',
  'completed',
  'first-completion',
  'intermediate-scanning'
] as const)(
  'resolves old Refresh failure only with a newer settled producer result: %s',
  async (outcome) => {
    const { api, store } = fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.refresh.mockRejectedValueOnce(new Error('lost Refresh'))
    await store.getState().refreshClaudeUsage()
    expect(store.getState().claudeUsageFailure?.refresh).toBe(true)
    const baseline = {
      ...scanState,
      lastScanCompletedAt: outcome === 'first-completion' ? null : 1
    }
    const final = {
      ...scanState,
      lastScanCompletedAt: outcome === 'skip' ? 1 : 2,
      isScanning: outcome === 'scanning',
      lastScanError: outcome === 'error' ? 'scan failed' : null
    }
    api.getSnapshot
      .mockResolvedValueOnce({ ...snapshot, scanState: baseline })
      .mockResolvedValueOnce({ ...snapshot, scanState: final })
    api.refresh.mockResolvedValueOnce(
      outcome === 'intermediate-scanning' ? { ...final, isScanning: true } : final
    )
    await store.getState().fetchClaudeUsage()
    expect(store.getState().claudeUsageFailure?.refresh ?? false).toBe(
      outcome !== 'completed' &&
        outcome !== 'first-completion' &&
        outcome !== 'intermediate-scanning'
    )
  }
)

it('retains unacknowledged setting writes through cache reads and never enables a disabled retry', async () => {
  const { api, store, notify } = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  api.setEnabled.mockRejectedValueOnce(new Error('lost acknowledgement'))
  await store.getState().setClaudeUsageEnabled(false)
  const stop = store.getState().observeClaudeUsage()
  await store.getState().fetchClaudeUsage()
  expect(store.getState().claudeUsageFailure?.setting).toBe(true)
  notify(false, { unavailable: true })
  stop()
  notify(true)
  api.getScanState.mockResolvedValue({ ...scanState, enabled: false })
  const remount = store.getState().observeClaudeUsage()
  await store.getState().fetchClaudeUsage()
  expect(store.getState().claudeUsageFailure).toMatchObject({ terminal: false, setting: true })
  api.refresh.mockClear()
  await store.getState().refreshClaudeUsage()
  expect(api.refresh).not.toHaveBeenCalled()
  expect(api.setEnabled).toHaveBeenCalledTimes(1)
  await store.getState().setClaudeUsageEnabled(false)
  expect(store.getState().claudeUsageFailure).toBeNull()
  remount()
})

it('does not treat an unsuccessful forced command as ordinary newer-scan recovery', async () => {
  const { api, store } = fixture()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  api.refresh.mockRejectedValueOnce(new Error('lost Refresh'))
  await store.getState().refreshClaudeUsage()
  api.getSnapshot.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({
    ...snapshot,
    scanState: { ...scanState, lastScanCompletedAt: 2 }
  })
  api.refresh.mockResolvedValueOnce({ ...scanState, lastScanError: 'scan failed' })
  await store.getState().refreshClaudeUsage()
  expect(store.getState().claudeUsageFailure?.refresh).toBe(true)
})
