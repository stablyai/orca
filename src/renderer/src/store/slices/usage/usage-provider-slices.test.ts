// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createClaudeUsageSlice } from './usage-provider-slices'
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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
