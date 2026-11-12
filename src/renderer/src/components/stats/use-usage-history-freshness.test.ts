// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UsageHistoryClient from './usage-history-client'
import type { UsageHistoryRow } from '../../../../shared/usage-history-types'
import { useUsageHistory } from './use-usage-history'

const remote = vi.hoisted(() => ({ supports: vi.fn(), call: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: remote.call }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: remote.supports
}))
vi.mock('./usage-history-client', async (load) => ({
  ...(await load<typeof UsageHistoryClient>()),
  usageHistoryAccounts: async () => ({
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: null
  })
}))

function history(day: string, totalTokens: number) {
  const row: UsageHistoryRow = {
    provider: 'codex',
    day,
    sessionId: 'session',
    projectKey: 'project',
    projectLabel: 'Project',
    inOrca: true,
    model: 'gpt-5.4',
    newInputTokens: totalTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens,
    activityCount: 1,
    apiEquivalentCostUsd: 0.01
  }
  return {
    scanState: {
      enabled: true,
      isScanning: false,
      lastScanStartedAt: 1,
      lastScanCompletedAt: 2,
      lastScanError: null
    },
    historyToday: '2026-11-12',
    history: [row]
  }
}

function installApi(initial = history('2026-11-10', 1200)) {
  let current = initial
  const codex = {
    getSnapshot: vi.fn(async () => current),
    refresh: vi.fn(async (_options: { force?: boolean }) => current.scanState),
    setEnabled: vi.fn()
  }
  const unsupported = { getSnapshot: async () => undefined, refresh: vi.fn(), setEnabled: vi.fn() }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      claudeUsage: unsupported,
      codexUsage: codex,
      openCodeUsage: unsupported,
      museUsage: unsupported
    }
  })
  return {
    ...codex,
    publish: (next: typeof initial) => {
      current = next
    }
  }
}

beforeEach(() => {
  remote.supports.mockReset().mockResolvedValue(true)
  remote.call.mockReset()
})
afterEach(cleanup)

describe('historical usage freshness on open', () => {
  it('replaces the old daily snapshot without a manual Refresh while keeping it readable during the scan', async () => {
    const codex = installApi()
    const pending = Promise.withResolvers<void>()
    codex.refresh.mockImplementation(async ({ force }) => {
      if (force) {
        throw new Error('Opening history must respect the host freshness policy')
      }
      await pending.promise
      codex.publish(history('2026-11-12', 2400))
      return history('2026-11-12', 2400).scanState
    })
    const { result } = renderHook(() => useUsageHistory())
    await waitFor(() =>
      expect(result.current.sources.find((s) => s.provider === 'codex')?.rows).toMatchObject([
        { day: '2026-11-10', totalTokens: 1200 }
      ])
    )
    expect(result.current.isRefreshing).toBe(true)
    await act(async () => pending.resolve())
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    expect(result.current.sources.find((s) => s.provider === 'codex')).toMatchObject({
      status: 'ready',
      rows: [{ day: '2026-11-12', totalTokens: 2400 }]
    })
  })

  it('refreshes the remote owner instead of the viewer and adopts its new day', async () => {
    const local = installApi()
    local.refresh.mockRejectedValue(new Error('Viewer logs are not the remote owner'))
    let current = history('2026-11-10', 1200)
    remote.call.mockImplementation(async (target, method, params) => {
      if (target.environmentId !== 'laptop') {
        throw new Error('Wrong usage owner')
      }
      if (params.provider !== 'codex') {
        return undefined
      }
      if (method === 'usage.getSnapshot') {
        return current
      }
      if (method === 'usage.refresh' && params.force === false) {
        current = history('2026-11-12', 3600)
        return current.scanState
      }
      throw new Error('Unexpected history operation')
    })
    const { result } = renderHook(() =>
      useUsageHistory({ kind: 'environment', environmentId: 'laptop' })
    )
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    expect(result.current.sources.find((s) => s.provider === 'codex')).toMatchObject({
      status: 'ready',
      rows: [{ day: '2026-11-12', totalTokens: 3600 }]
    })
  })
})
