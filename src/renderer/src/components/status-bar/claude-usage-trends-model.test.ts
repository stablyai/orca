import { describe, expect, it } from 'vitest'
import type { ClaudeUsageHourlyPoint } from '../../../../shared/claude-usage-types'
import {
  buildDayTrend,
  buildHourOfDayModel,
  buildMonotoneLinePath,
  getHourTooltipStats,
  listRecentLocalDays,
  pointTotalTokens
} from './claude-usage-trends-model'

// Why: local-time Date construction keeps day keys deterministic across CI zones.
const REFERENCE = new Date(2026, 3, 9, 12, 0, 0)

function makePoint(
  day: string,
  hour: number,
  overrides: Partial<ClaudeUsageHourlyPoint> = {}
): ClaudeUsageHourlyPoint {
  return {
    day,
    hour,
    turnCount: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    ...overrides
  }
}

describe('listRecentLocalDays', () => {
  it('returns local day keys oldest to today', () => {
    expect(listRecentLocalDays(3, REFERENCE)).toEqual(['2026-04-07', '2026-04-08', '2026-04-09'])
  })
})

describe('buildHourOfDayModel', () => {
  it('buckets points into day columns by hour and tracks the max cell', () => {
    const model = buildHourOfDayModel(
      [
        makePoint('2026-04-09', 10),
        makePoint('2026-04-09', 10, { inputTokens: 50 }),
        makePoint('2026-04-08', 22, { inputTokens: 1000 }),
        makePoint('2026-01-01', 5, { inputTokens: 9999 })
      ],
      7,
      REFERENCE
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
  it('zero-fills daily buckets across the window and sums totals', () => {
    const trend = buildDayTrend(
      [makePoint('2026-04-09', 10), makePoint('2026-04-09', 22), makePoint('2026-04-05', 3)],
      '7d',
      REFERENCE
    )

    expect(trend.kind).toBe('day')
    expect(trend.buckets).toHaveLength(7)
    expect(trend.buckets.at(-1)?.totalTokens).toBe(270)
    expect(trend.buckets.find((bucket) => bucket.key === '2026-04-05')?.totalTokens).toBe(135)
    expect(trend.buckets.find((bucket) => bucket.key === '2026-04-06')?.totalTokens).toBe(0)
    expect(trend.maxTotalTokens).toBe(270)
    expect(trend.windowTotalTokens).toBe(405)
  })

  it('buckets the 6M window by month and drops points before the window', () => {
    const trend = buildDayTrend(
      [
        makePoint('2026-04-01', 10),
        makePoint('2026-03-15', 10, { inputTokens: 200 }),
        makePoint('2025-01-01', 10, { inputTokens: 9999 })
      ],
      '6m',
      REFERENCE
    )

    expect(trend.kind).toBe('month')
    // 180 days before 2026-04-09 lands mid-October, so the partial oldest
    // month is trimmed and the series starts at the first full month.
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
    // Flat input must stay flat: every y coordinate (odd position) is 95.
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
  it('averages only days with activity at that hour and reports the peak', () => {
    const model = buildHourOfDayModel(
      [
        makePoint('2026-04-09', 10, {
          inputTokens: 65,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          turnCount: 1
        }),
        makePoint('2026-04-08', 10, {
          inputTokens: 300,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0
        })
      ],
      7,
      REFERENCE
    )

    const stats = getHourTooltipStats(model, 10)
    expect(stats.today).toBe(65)
    expect(stats.peak).toBe(300)
    expect(stats.average).toBe(Math.round((65 + 300) / 2))
  })
})

describe('pointTotalTokens', () => {
  it('sums all four token counters', () => {
    expect(pointTotalTokens(makePoint('2026-04-09', 1))).toBe(135)
  })
})
