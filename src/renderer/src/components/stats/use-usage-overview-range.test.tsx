// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexUsageSnapshot } from '../../../../shared/codex-usage-types'
import type { UsageRange } from '../../../../shared/usage-range'
import type { UsageOverviewInput } from './usage-overview-types'
import { buildUsageOverview } from './usage-overview-model'
import { queryUsageOverviewRange, useUsageOverviewRange } from './use-usage-overview-range'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

/** Builds a cached response with distinguishable range totals and costs. */
function snapshot(range: UsageRange, totalTokens: number): CodexUsageSnapshot {
  return {
    scanState: {
      enabled: true,
      isScanning: false,
      lastScanStartedAt: 1,
      lastScanCompletedAt: 2,
      lastScanError: null,
      hasAnyCodexData: true
    },
    summary: {
      scope: 'all',
      range,
      sessions: 1,
      events: 2,
      inputTokens: totalTokens - 10,
      cachedInputTokens: 20,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens,
      estimatedCostUsd: totalTokens / 100,
      hasUnpricedModels: false,
      topModel: 'test-model',
      topProject: 'test-project',
      hasAnyCodexData: true
    },
    daily: [
      {
        day: '2026-10-16',
        inputTokens: totalTokens - 10,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens
      }
    ],
    modelBreakdown: [],
    projectBreakdown: [],
    recentSessions: []
  }
}

/** Starts with a provider detail range that overview queries must preserve. */
function source(): UsageOverviewInput {
  return {
    claude: { scanState: null, summary: null, daily: [] },
    codex: snapshot('90d', 9000),
    opencode: { scanState: null, summary: null, daily: [] },
    muse: { scanState: null, summary: null, daily: [] }
  }
}

const getSnapshot =
  vi.fn<(args: { scope: string; range: UsageRange }) => Promise<CodexUsageSnapshot>>()

beforeEach(() => {
  getSnapshot.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { codexUsage: { getSnapshot } }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('overview range queries', () => {
  it.each([
    ['today', 100],
    ['7d', 700],
    ['30d', 3000],
    ['all', 9000]
  ] as const)(
    'uses the selected %s snapshot for totals, cost and token mix',
    async (range, tokens) => {
      const input = source()
      getSnapshot.mockResolvedValue(snapshot(range, tokens))
      const scoped = await queryUsageOverviewRange(input, range)
      const overview = buildUsageOverview(scoped)

      expect(getSnapshot).toHaveBeenCalledWith({ scope: 'all', range })
      expect(overview).toMatchObject({
        totalTokens: tokens,
        estimatedCostUsd: tokens / 100,
        newInputTokens: tokens - 30,
        cacheTokens: 20,
        outputTokens: 10,
        activeDays: 1,
        daily: [{ totalTokens: tokens }]
      })
      expect(input.codex.summary?.range).toBe('90d')
      expect(input.codex.summary?.totalTokens).toBe(9000)
    }
  )

  it('does not query disabled providers', async () => {
    const input = source()
    input.codex.scanState = null
    expect(await queryUsageOverviewRange(input, 'today')).toEqual(input)
    expect(getSnapshot).not.toHaveBeenCalled()
  })

  it('ignores a slower previous range after the selection changes', async () => {
    let finishOld!: (value: CodexUsageSnapshot) => void
    getSnapshot.mockImplementation(({ range }) =>
      range === '30d'
        ? new Promise((resolve) => {
            finishOld = resolve
          })
        : Promise.resolve(snapshot(range, 100))
    )
    const input = source()
    const { result, rerender } = renderHook(
      ({ range }: { range: UsageRange }) => useUsageOverviewRange(input, range, '2026-10-16'),
      { initialProps: { range: '30d' } }
    )
    expect(result.current.loading).toBe(true)
    rerender({ range: 'today' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.input.codex.summary?.totalTokens).toBe(100)
    await act(async () => finishOld(snapshot('30d', 3000)))
    expect(result.current.input.codex.summary?.range).toBe('today')
    expect(result.current.input.codex.summary?.totalTokens).toBe(100)
  })

  it('reloads after a scan or a local calendar-day rollover', async () => {
    getSnapshot.mockImplementation(({ range }) => Promise.resolve(snapshot(range, 100)))
    const input = source()
    const { result, rerender } = renderHook(
      ({ input, day }) => useUsageOverviewRange(input, 'today', day),
      { initialProps: { input, day: '2026-10-16' } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ input, day: '2026-10-17' })
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2))
    rerender({ input: source(), day: '2026-10-17' })
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(3))
  })

  it('exposes query failure instead of presenting another range as current', async () => {
    getSnapshot.mockRejectedValue(new Error('query failed'))
    const input = source()
    const { result } = renderHook(() => useUsageOverviewRange(input, 'today', '2026-10-16'))
    await waitFor(() => expect(result.current.error).toBe('query failed'))
    expect(result.current.loading).toBe(false)
  })
})
