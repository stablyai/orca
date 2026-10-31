// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexUsageSnapshot } from '../../../../shared/codex-usage-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { USAGE_HISTORY_RUNTIME_CAPABILITY } from '../../../../shared/usage-history-rpc'
import { useUsageHistory } from './use-usage-history'

const remote = vi.hoisted(() => ({ supports: vi.fn(), call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: remote.supports,
  callRuntimeRpc: remote.call
}))

beforeEach(() => {
  remote.supports.mockReset().mockResolvedValue(true)
  remote.call.mockReset().mockImplementation(async (_target, method, params) => {
    if (method !== 'usage.getSnapshot') {
      return snapshot().scanState
    }
    const result = snapshot()
    return params.provider === 'codex'
      ? result
      : { ...result, history: [], scanState: { ...result.scanState, enabled: false } }
  })
})

function snapshot(): CodexUsageSnapshot {
  return {
    scanState: {
      enabled: true,
      isScanning: false,
      lastScanStartedAt: 100,
      lastScanCompletedAt: 200,
      lastScanError: null,
      hasAnyCodexData: true
    },
    summary: {
      scope: 'all',
      range: 'all',
      sessions: 1,
      events: 1,
      inputTokens: 1000,
      cachedInputTokens: 900,
      outputTokens: 200,
      reasoningOutputTokens: 100,
      totalTokens: 1200,
      estimatedCostUsd: 0.01,
      hasUnpricedModels: false,
      topModel: 'gpt-5.4',
      topProject: 'Folder',
      hasAnyCodexData: true
    },
    daily: [],
    modelBreakdown: [],
    projectBreakdown: [],
    recentSessions: [],
    historyToday: '2026-10-25',
    history: [
      {
        provider: 'codex',
        day: '2026-10-24',
        sessionId: 'session',
        projectKey: 'folder',
        projectLabel: 'Folder',
        inOrca: true,
        model: 'gpt-5.4',
        newInputTokens: 100,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        outputTokens: 200,
        reasoningTokens: 100,
        totalTokens: 1200,
        activityCount: 1,
        apiEquivalentCostUsd: 0.01
      }
    ]
  }
}

function installApi(current: CodexUsageSnapshot | undefined) {
  const codex = {
    getSnapshot: vi.fn(async () => current),
    refresh: vi.fn(async () => current?.scanState),
    setEnabled: vi.fn(async () => current?.scanState)
  }
  const unsupported = {
    getSnapshot: vi.fn(async () => undefined),
    refresh: vi.fn(),
    setEnabled: vi.fn()
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      claudeUsage: unsupported,
      codexUsage: codex,
      openCodeUsage: unsupported,
      museUsage: unsupported
    }
  })
  return codex
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('existing historical source snapshots', () => {
  it('routes all remote reads, scans and enabling to the owner without touching local logs', async () => {
    const local = installApi(snapshot())
    const target: RuntimeClientTarget = { kind: 'environment', environmentId: 'build-server' }
    const { result } = renderHook(() => useUsageHistory(target))
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    expect(remote.supports).toHaveBeenCalledWith('build-server', USAGE_HISTORY_RUNTIME_CAPABILITY)
    expect(remote.call).toHaveBeenCalledWith(target, 'usage.getSnapshot', {
      provider: 'codex',
      scope: 'all',
      range: 'all',
      limit: 0,
      includeHistory: true
    })
    expect(remote.call).toHaveBeenCalledWith(
      target,
      'usage.refresh',
      {
        provider: 'codex',
        force: false
      },
      expect.anything()
    )
    expect(result.current.sources.find((source) => source.provider === 'codex')?.historyToday).toBe(
      '2026-10-25'
    )
    expect(local.getSnapshot).not.toHaveBeenCalled()
    expect(local.refresh).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.enable('codex')
    })
    expect(remote.call).toHaveBeenCalledWith(target, 'usage.setEnabled', {
      provider: 'codex',
      enabled: true
    })
    expect(local.setEnabled).not.toHaveBeenCalled()
  })

  it('clears local rows when switching to an old host and never refreshes or enables it', async () => {
    const local = installApi(snapshot())
    const { result, rerender } = renderHook(
      ({ target }: { target: RuntimeClientTarget }) => useUsageHistory(target),
      {
        initialProps: { target: { kind: 'local' } }
      }
    )
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    expect(result.current.sources.some((source) => source.rows.length > 0)).toBe(true)
    const reads = local.getSnapshot.mock.calls.length
    remote.supports.mockResolvedValue(false)
    rerender({ target: { kind: 'environment', environmentId: 'old-host' } })
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    expect(
      result.current.sources.every(
        (source) => source.status === 'unsupported' && source.rows.length === 0
      )
    ).toBe(true)
    await act(async () => {
      await result.current.enable('codex')
    })
    expect(remote.call).not.toHaveBeenCalled()
    expect(local.getSnapshot).toHaveBeenCalledTimes(reads)
  })

  it('shows an offline owner as an error with no local fallback', async () => {
    const local = installApi(snapshot())
    remote.supports.mockRejectedValue(new Error('Owner connection unavailable'))
    const { result } = renderHook(() =>
      useUsageHistory({ kind: 'environment', environmentId: 'offline' })
    )
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    expect(
      result.current.sources.every(
        (source) =>
          source.status === 'error' &&
          source.rows.length === 0 &&
          source.error === 'Owner connection unavailable'
      )
    ).toBe(true)
    expect(remote.call).not.toHaveBeenCalled()
    expect(local.getSnapshot).not.toHaveBeenCalled()
  })

  it('invalidates a late snapshot after switching owners and does not scan the old host', async () => {
    installApi(snapshot())
    const pending = Promise.withResolvers<CodexUsageSnapshot>()
    remote.call.mockImplementation(async (target, method, params) => {
      if (method === 'usage.getSnapshot') {
        return target.environmentId === 'host-a' && params.provider === 'codex'
          ? pending.promise
          : snapshot()
      }
      return snapshot().scanState
    })
    const { result, rerender } = renderHook(
      ({ target }: { target: RuntimeClientTarget }) => useUsageHistory(target),
      {
        initialProps: { target: { kind: 'environment', environmentId: 'host-a' } }
      }
    )
    await waitFor(() => expect(remote.call).toHaveBeenCalled())
    rerender({ target: { kind: 'environment', environmentId: 'host-b' } })
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    const late = snapshot()
    late.history = late.history?.map((row) => ({ ...row, totalTokens: 999999 }))
    await act(async () => {
      pending.resolve(late)
      await pending.promise
    })
    expect(
      result.current.sources
        .flatMap((source) => source.rows)
        .every((row) => row.totalTokens === 1200)
    ).toBe(true)
    expect(remote.call).not.toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'host-a' },
      'usage.refresh',
      { provider: 'codex', force: false },
      expect.anything()
    )
  })

  it('retains last scanned rows and freshness when a later read fails, while unsupported clients stay unavailable', async () => {
    const codex = installApi(snapshot())
    const { result } = renderHook(() => useUsageHistory())
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    expect(result.current.sources.find((source) => source.provider === 'codex')).toMatchObject({
      status: 'ready',
      lastScanCompletedAt: 200,
      rows: [expect.objectContaining({ totalTokens: 1200 })]
    })
    expect(result.current.sources.find((source) => source.provider === 'claude')).toMatchObject({
      status: 'unsupported',
      rows: []
    })
    codex.getSnapshot.mockRejectedValue(new Error('Fixture source offline'))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.sources.find((source) => source.provider === 'codex')).toMatchObject({
      status: 'error',
      error: 'Fixture source offline',
      lastScanCompletedAt: 200,
      rows: [expect.objectContaining({ totalTokens: 1200 })]
    })
  })

  it('does not expose cached rows from disabled tracking as current history', async () => {
    const cached = snapshot()
    cached.scanState.enabled = false
    installApi(cached)
    const { result } = renderHook(() => useUsageHistory())
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    expect(result.current.sources.find((source) => source.provider === 'codex')).toMatchObject({
      enabled: false,
      status: 'ready',
      rows: []
    })
  })

  it('distinguishes older snapshots without the new projection from a zero-usage scan', async () => {
    const { history: _history, ...legacy } = snapshot()
    installApi(legacy)
    const { result } = renderHook(() => useUsageHistory())
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    expect(result.current.sources.find((source) => source.provider === 'codex')).toMatchObject({
      status: 'unsupported',
      rows: []
    })
  })

  it('withholds unvalidated saved totals until a scan rebuilds the historical projection', async () => {
    installApi({ ...snapshot(), historyNeedsRescan: true })
    const { result } = renderHook(() => useUsageHistory())
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    expect(result.current.sources.find((source) => source.provider === 'codex')).toMatchObject({
      status: 'ready',
      needsRescan: true,
      rows: []
    })
  })
})
