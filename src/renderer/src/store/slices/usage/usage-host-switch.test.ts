import { afterEach, expect, it, vi } from 'vitest'
import { create } from 'zustand'

const remote = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../../../runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: remote.call }))

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
  const { createStatsSlice } = await import('../process-stats/stats')
  const { createClaudeUsageSlice } = await import('./usage-provider-slices')
  // oxlint-disable-next-line typescript/no-explicit-any -- SAFETY: the two slices under test read only their own fields.
  const store = create<any>()((...args) => ({
    // oxlint-disable-next-line typescript/no-explicit-any -- SAFETY: see above.
    ...createStatsSlice(...(args as any)),
    // oxlint-disable-next-line typescript/no-explicit-any -- SAFETY: see above.
    ...createClaudeUsageSlice(...(args as any))
  }))

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
