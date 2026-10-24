import { create } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { createClaudeUsageSlice } from './usage-provider-slices'
import { createStatsSlice } from './stats'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('../../runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))

const SERVER = { kind: 'environment', environmentId: 'env-1' } as const

function scanState(label: string) {
  return {
    enabled: true,
    isScanning: false,
    lastScanStartedAt: 1,
    lastScanCompletedAt: 2,
    lastScanError: null,
    hasAnyClaudeData: true,
    label
  }
}

function snapshot(label: string) {
  return {
    scanState: scanState(label),
    summary: { label },
    daily: [],
    modelBreakdown: [],
    projectBreakdown: [],
    recentSessions: []
  }
}

function stubLocalApi(overrides: Record<string, unknown> = {}) {
  const claudeUsage = {
    getScanState: vi.fn(async () => scanState('local')),
    setEnabled: vi.fn(async () => scanState('local')),
    refresh: vi.fn(async () => scanState('local')),
    getSnapshot: vi.fn(async () => snapshot('local')),
    ...overrides
  }
  vi.stubGlobal('window', {
    api: { claudeUsage, stats: { getSummary: vi.fn(async () => ({ totalAgentsSpawned: 1 })) } }
  })
  return claudeUsage
}

function createStore() {
  return create<AppState>()(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The host switch reads only the stats host and the Claude usage slice supplied here.
    (...args) => ({ ...createStatsSlice(...args), ...createClaudeUsageSlice(...args) }) as AppState
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Stats & Usage host', () => {
  it('reads this computer through the desktop usage API by default', async () => {
    const local = stubLocalApi()
    const store = createStore()

    await store.getState().fetchClaudeUsage()

    expect(local.getSnapshot).toHaveBeenCalled()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(store.getState().claudeUsageSummary).toEqual({ label: 'local' })
  })

  it('reads a chosen server over its runtime and keeps the pane filters', async () => {
    const local = stubLocalApi()
    callRuntimeRpc.mockImplementation(async (_target, method: string) =>
      method === 'usage.getSnapshot' ? snapshot('server') : scanState('server')
    )
    const store = createStore()
    await store.getState().setClaudeUsageRange('7d')
    const localReads = local.getSnapshot.mock.calls.length

    store.getState().setStatsHost(SERVER)
    expect(store.getState().claudeUsageSummary).toBeNull()
    await store.getState().fetchClaudeUsage({ forceRefresh: true })

    expect(callRuntimeRpc).toHaveBeenCalledWith(SERVER, 'usage.getScanState', {
      provider: 'claude'
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      SERVER,
      'usage.refresh',
      { provider: 'claude', force: true },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(SERVER, 'usage.getSnapshot', {
      provider: 'claude',
      scope: 'orca',
      range: '7d',
      limit: 10
    })
    expect(local.getSnapshot).toHaveBeenCalledTimes(localReads)
    expect(store.getState().claudeUsageSummary).toEqual({ label: 'server' })
  })

  it('drops an answer that arrives after the host changed', async () => {
    let releaseLocal: (value: ReturnType<typeof snapshot>) => void = () => {}
    stubLocalApi({
      getSnapshot: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseLocal = resolve
          })
      )
    })
    const store = createStore()

    const pending = store.getState().fetchClaudeUsage()
    await vi.waitFor(() => expect(store.getState().claudeUsageScanState).not.toBeNull())
    store.getState().setStatsHost(SERVER)
    releaseLocal(snapshot('local'))
    await pending

    expect(store.getState().claudeUsageScanState).toBeNull()
    expect(store.getState().claudeUsageSummary).toBeNull()
    expect(window.api.claudeUsage.refresh).not.toHaveBeenCalled()
  })

  it("reads the server's Orca stats and ignores the empty answer of a host without them", async () => {
    stubLocalApi()
    callRuntimeRpc.mockResolvedValueOnce({})
    const store = createStore()
    store.getState().setStatsHost(SERVER)

    await store.getState().fetchStatsSummary()

    expect(callRuntimeRpc).toHaveBeenCalledWith(SERVER, 'stats.summary')
    expect(store.getState().statsSummary).toBeNull()
  })
})
