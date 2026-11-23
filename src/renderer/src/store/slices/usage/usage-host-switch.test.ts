import { afterEach, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'

const remote = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../../../runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: remote.call }))
vi.mock('../../../runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async () => true
}))

afterEach(() => {
  vi.unstubAllGlobals()
  remote.call.mockReset()
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function snapshot(sessions: number) {
  return {
    scanState: {
      enabled: true,
      isScanning: false,
      lastScanStartedAt: 1,
      lastScanCompletedAt: 2,
      lastScanError: null,
      hasAnyClaudeData: true
    },
    summary: { sessions, hasAnyClaudeData: true },
    daily: [],
    modelBreakdown: [],
    projectBreakdown: [],
    recentSessions: []
  }
}

async function createUsageStore() {
  const { createStatsSlice } = await import('../process-stats/stats')
  const { createClaudeUsageSlice } = await import('./usage-provider-slices')
  return create<AppState>()((...args) => {
    const state = { ...createStatsSlice(...args), ...createClaudeUsageSlice(...args) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the two slices under test read only their own fields; unrelated AppState services are intentionally absent.
    return state as unknown as AppState
  })
}

it("never shows one host's usage after switching to another", async () => {
  const localSnapshot = deferred<ReturnType<typeof snapshot>>()
  const local = {
    getScanState: vi.fn(async () => snapshot(1).scanState),
    getSnapshot: vi.fn(() => localSnapshot.promise),
    refresh: vi.fn(async () => snapshot(1).scanState),
    setEnabled: vi.fn()
  }
  vi.stubGlobal('window', { api: { claudeUsage: local } })
  remote.call.mockImplementation(async (_target, _method, params: { method: string }) =>
    params.method === 'claudeUsage:getSnapshot' ? snapshot(7) : snapshot(7).scanState
  )
  const store = await createUsageStore()

  const localRead = store.getState().fetchClaudeUsage()
  await vi.waitFor(() => expect(local.getSnapshot).toHaveBeenCalled())
  store.getState().setStatsHost({ kind: 'environment', environmentId: 'devbox' })
  // This computer answers after the switch, before devbox is asked.
  localSnapshot.resolve(snapshot(1))
  await localRead
  expect(store.getState().claudeUsageSummary).toBeNull()

  await store.getState().fetchClaudeUsage()
  expect(store.getState().claudeUsageSummary).toEqual({ sessions: 7, hasAnyClaudeData: true })
  expect(remote.call.mock.calls[0][0]).toEqual({ kind: 'environment', environmentId: 'devbox' })
})

it('starts fresh when the view returns to a host whose old read never finished', async () => {
  const stuck = deferred<ReturnType<typeof snapshot>>()
  const local = {
    getScanState: vi.fn(async () => snapshot(1).scanState),
    getSnapshot: vi.fn().mockReturnValueOnce(stuck.promise).mockResolvedValue(snapshot(3)),
    refresh: vi.fn(async () => snapshot(3).scanState),
    setEnabled: vi.fn()
  }
  vi.stubGlobal('window', { api: { claudeUsage: local } })
  const store = await createUsageStore()

  void store.getState().fetchClaudeUsage()
  await vi.waitFor(() => expect(local.getSnapshot).toHaveBeenCalled())
  store.getState().setStatsHost({ kind: 'environment', environmentId: 'devbox' })
  store.getState().setStatsHost({ kind: 'local' })
  await store.getState().fetchClaudeUsage()
  expect(store.getState().claudeUsageSummary).toEqual({ sessions: 3, hasAnyClaudeData: true })
})

it('stops reading a host once the view moves on', async () => {
  const scanState = deferred<ReturnType<typeof snapshot>['scanState']>()
  remote.call.mockImplementation(async (_target, _method, params: { method: string }) =>
    params.method === 'claudeUsage:getScanState' ? scanState.promise : snapshot(7)
  )
  vi.stubGlobal('window', { api: { claudeUsage: { getScanState: () => new Promise(() => {}) } } })
  const store = await createUsageStore()

  store.getState().setStatsHost({ kind: 'environment', environmentId: 'devbox' })
  const devboxRead = store.getState().fetchClaudeUsage()
  await vi.waitFor(() => expect(remote.call).toHaveBeenCalledTimes(1))
  store.getState().setStatsHost({ kind: 'local' })
  scanState.resolve(snapshot(7).scanState)
  await devboxRead
  // Without the view check devbox would still be asked for its snapshot and a refresh.
  expect(remote.call).toHaveBeenCalledTimes(1)
})
