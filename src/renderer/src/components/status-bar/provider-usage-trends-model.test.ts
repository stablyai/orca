import { describe, expect, it } from 'vitest'
import {
  buildDayTrend,
  buildHourOfDayModel,
  buildMonotoneLinePath,
  getHourTooltipStats,
  getTimeTrendsLineOpacity,
  listLocalDaysInRange,
  listRecentLocalDays,
  pointTotalTokens,
  type UsageHourlyPoint
} from './provider-usage-trends-model'

// Why: local-time Date construction keeps day keys deterministic across CI zones.
const REFERENCE = new Date(2026, 3, 9, 12, 0, 0)

function makePoint(
  day: string,
  hour: number,
  overrides: Partial<UsageHourlyPoint> = {}
): UsageHourlyPoint {
  return {
    day,
    hour,
    eventCount: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    reasoningOutputTokens: 0,
    toolTokens: 0,
    totalTokens: 135,
    ...overrides
  }
}

describe('local day lists', () => {
  it('returns recent local day keys oldest to today', () => {
    expect(listRecentLocalDays(3, REFERENCE)).toEqual(['2026-04-07', '2026-04-08', '2026-04-09'])
  })

  it('returns every valid day in a custom inclusive range', () => {
    expect(listLocalDaysInRange('2025-12-30', '2026-01-02')).toEqual([
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02'
    ])
    expect(listLocalDaysInRange('2026-02-30', '2026-03-01')).toEqual([])
  })
})

describe('buildHourOfDayModel', () => {
  it('buckets points into selected day columns by hour and tracks the max cell', () => {
    const dayKeys = listRecentLocalDays(7, REFERENCE)
    const model = buildHourOfDayModel(
      [
        makePoint('2026-04-09', 10),
        makePoint('2026-04-09', 10, { inputTokens: 50, totalTokens: 85 }),
        makePoint('2026-04-08', 22, { inputTokens: 1000, totalTokens: 1035 }),
        makePoint('2026-01-01', 5, { inputTokens: 9999, totalTokens: 9999 })
      ],
      dayKeys
    )

    expect(model.dayKeys).toHaveLength(7)
    expect(model.dayKeys.at(-1)).toBe('2026-04-09')
    expect(model.columns.at(-1)?.[10]).toBe(135 + 85)
    expect(model.columns.at(-2)?.[22]).toBe(1035)
    expect(model.maxTokens).toBe(1035)
    expect(model.columns[0].every((value) => value === 0)).toBe(true)
  })
})

describe('buildDayTrend', () => {
  it('zero-fills daily buckets across the selected window and sums totals', () => {
    const trend = buildDayTrend(
      [makePoint('2026-04-09', 10), makePoint('2026-04-09', 22), makePoint('2026-04-05', 3)],
      listRecentLocalDays(7, REFERENCE)
    )

    expect(trend.kind).toBe('day')
    expect(trend.buckets).toHaveLength(7)
    expect(trend.buckets.at(-1)?.totalTokens).toBe(270)
    expect(trend.buckets.find((bucket) => bucket.key === '2026-04-05')?.totalTokens).toBe(135)
    expect(trend.buckets.find((bucket) => bucket.key === '2026-04-06')?.totalTokens).toBe(0)
    expect(trend.maxTotalTokens).toBe(270)
    expect(trend.windowTotalTokens).toBe(405)
  })

  it('buckets a long preset by month and trims its leading partial month', () => {
    const trend = buildDayTrend(
      [
        makePoint('2026-04-01', 10),
        makePoint('2026-03-15', 10, { inputTokens: 200, totalTokens: 235 }),
        makePoint('2025-01-01', 10, { inputTokens: 9999, totalTokens: 9999 })
      ],
      listRecentLocalDays(180, REFERENCE),
      { trimPartialFirstMonth: true }
    )

    expect(trend.kind).toBe('month')
    expect(trend.buckets[0]?.key).toBe('2025-11')
    expect(trend.buckets.at(-1)?.key).toBe('2026-04')
    expect(trend.buckets.at(-1)?.totalTokens).toBe(135)
    expect(trend.buckets.find((bucket) => bucket.key === '2026-03')?.totalTokens).toBe(235)
    expect(trend.buckets.some((bucket) => bucket.key === '2025-01')).toBe(false)
    expect(trend.windowTotalTokens).toBe(370)
  })
})

describe('buildMonotoneLinePath', () => {
  const toX = (index: number): number => index * 10
  const toY = (value: number): number => 100 - value

  it('produces a cubic path through every point without overshoot on flat data', () => {
    const path = buildMonotoneLinePath([5, 5, 5], toX, toY)
    expect(path.startsWith('M0,95')).toBe(true)
    expect(path.match(/C/g)).toHaveLength(2)
    const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
    const yValues = numbers.filter((_, index) => index % 2 === 1)
    expect(yValues.length).toBeGreaterThan(0)
    expect(yValues.every((value) => value === 95)).toBe(true)
  })

  it('handles empty and single-point series', () => {
    expect(buildMonotoneLinePath([], toX, toY)).toBe('')
    expect(buildMonotoneLinePath([3], toX, toY)).toBe('M0,97')
  })
})

describe('getHourTooltipStats', () => {
  it('averages only active days and reports the selected range end separately', () => {
    const model = buildHourOfDayModel(
      [
        makePoint('2026-04-09', 10, {
          inputTokens: 65,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 65
        }),
        makePoint('2026-04-08', 10, {
          inputTokens: 300,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 300
        })
      ],
      listRecentLocalDays(7, REFERENCE)
    )

    const stats = getHourTooltipStats(model, 10)
    expect(stats.latest).toBe(65)
    expect(stats.peak).toBe(300)
    expect(stats.average).toBe(Math.round((65 + 300) / 2))
  })
})

describe('pointTotalTokens', () => {
  it('uses the provider-reported total so cached and reasoning tokens are not double-counted', () => {
    expect(pointTotalTokens(makePoint('2026-04-09', 1, { totalTokens: 120 }))).toBe(120)
  })
})

describe('getTimeTrendsLineOpacity', () => {
  it('lowers line opacity for long custom ranges while retaining a visible floor', () => {
    expect(getTimeTrendsLineOpacity(1)).toBe(0.9)
    expect(getTimeTrendsLineOpacity(365)).toBeLessThan(0.08)
    expect(getTimeTrendsLineOpacity(10_000)).toBe(0.02)
  })
})
