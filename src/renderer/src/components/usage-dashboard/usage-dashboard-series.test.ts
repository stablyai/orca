import { describe, expect, it } from 'vitest'
import {
  buildUsageDashboardDailySeries,
  buildUsageDashboardModelRows,
  type UsageDashboardDailyPoint
} from './usage-dashboard-series'

function point(
  day: string,
  values: Partial<Omit<UsageDashboardDailyPoint, 'day'>> & { reasoningTokens?: number }
): UsageDashboardDailyPoint {
  return {
    day,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    ...values
  }
}

const ANCHOR = new Date('2026-05-15T12:00:00')

describe('buildUsageDashboardDailySeries', () => {
  it('merges every provider field per day and keeps one-sided days', () => {
    const series = buildUsageDashboardDailySeries(
      [
        {
          id: 'claude',
          daily: [
            point('2026-05-14', {
              inputTokens: 100,
              outputTokens: 10,
              cacheReadTokens: 50,
              cacheWriteTokens: 5
            }),
            point('2026-05-15', { inputTokens: 7, outputTokens: 3 })
          ]
        },
        {
          id: 'omp',
          daily: [
            point('2026-05-14', {
              inputTokens: 1,
              outputTokens: 2,
              cacheReadTokens: 3,
              cacheWriteTokens: 4,
              reasoningTokens: 9,
              costUsd: 0.5
            })
          ]
        }
      ],
      2,
      ANCHOR
    )

    expect(series).toHaveLength(2)
    expect(series[0]).toEqual({
      day: '2026-05-14',
      inputTokens: 101,
      outputTokens: 12,
      cacheReadTokens: 53,
      cacheWriteTokens: 9,
      reasoningTokens: 9,
      costUsd: 0.5
    })
    // The day only Claude reported still appears, and reasoning stays absent for it.
    expect(series[1]).toEqual({
      day: '2026-05-15',
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0
    })
    expect(series[1].reasoningTokens).toBeUndefined()
  })

  it('zero-fills the requested window, ascending, immediately before the anchor day', () => {
    const series = buildUsageDashboardDailySeries(
      [{ id: 'codex', daily: [point('2026-05-14', { inputTokens: 4, outputTokens: 6 })] }],
      3,
      ANCHOR
    )

    expect(series.map((entry) => entry.day)).toEqual(['2026-05-13', '2026-05-14', '2026-05-15'])
    expect(series.map((entry) => entry.inputTokens)).toEqual([0, 4, 0])
    expect(series.map((entry) => entry.outputTokens)).toEqual([0, 6, 0])
    expect(series.every((entry) => entry.costUsd === 0)).toBe(true)
  })

  it('keeps out-of-window days out of the result', () => {
    const series = buildUsageDashboardDailySeries(
      [{ id: 'claude', daily: [point('2026-04-01', { inputTokens: 999 })] }],
      2,
      ANCHOR
    )

    expect(series.map((entry) => entry.day)).toEqual(['2026-05-14', '2026-05-15'])
    expect(series.some((entry) => entry.inputTokens === 999)).toBe(false)
  })

  it('surfaces reasoningTokens only when a provider supplies it and never folds it into output', () => {
    const series = buildUsageDashboardDailySeries(
      [
        {
          id: 'omp',
          daily: [
            point('2026-05-14', { inputTokens: 1, outputTokens: 2, reasoningTokens: 30 }),
            point('2026-05-15', { inputTokens: 10, outputTokens: 20, reasoningTokens: 0 })
          ]
        }
      ],
      2,
      ANCHOR
    )

    const [withReasoning, withZero] = series
    expect(withReasoning.reasoningTokens).toBe(30)
    expect(withReasoning.outputTokens).toBe(2)
    expect(withZero.reasoningTokens).toBe(0)
    expect(withZero.outputTokens).toBe(20)
  })

  it('treats non-finite provider values as zero', () => {
    const series = buildUsageDashboardDailySeries(
      [
        {
          id: 'claude',
          daily: [
            point('2026-05-15', {
              inputTokens: Number.NaN,
              outputTokens: Number.POSITIVE_INFINITY,
              cacheReadTokens: 5,
              costUsd: Number.NaN
            })
          ]
        }
      ],
      1,
      ANCHOR
    )

    expect(series[0]).toEqual({
      day: '2026-05-15',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      costUsd: 0
    })
  })

  it('clamps a non-positive window to a single day', () => {
    expect(buildUsageDashboardDailySeries([], 0, ANCHOR)).toHaveLength(1)
  })
})

describe('buildUsageDashboardModelRows', () => {
  it('flattens providers, sorts by total tokens, and keeps unknown costs null', () => {
    const rows = buildUsageDashboardModelRows([
      {
        id: 'claude',
        rows: [
          {
            model: 'claude-sonnet-4-5',
            inputTokens: 1_000,
            outputTokens: 500,
            cacheReadTokens: 2_000,
            cacheWriteTokens: 100,
            costUsd: 0.42
          }
        ]
      },
      {
        id: 'muse',
        rows: [
          {
            model: 'muse-spark',
            inputTokens: 50,
            outputTokens: 25,
            cacheReadTokens: 0,
            cacheWriteTokens: 0
          }
        ]
      },
      {
        id: 'omp',
        rows: [
          {
            model: 'gpt-5.4',
            inputTokens: 4_000,
            outputTokens: 1_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 250,
            costUsd: 1.5
          }
        ]
      }
    ])

    expect(rows.map((row) => row.model)).toEqual(['gpt-5.4', 'claude-sonnet-4-5', 'muse-spark'])
    expect(rows[0]).toMatchObject({
      provider: 'omp',
      reasoningTokens: 250,
      // Resolution 8: reasoning is reported beside the totals, never inside them.
      totalTokens: 5_000,
      costUsd: 1.5
    })
    expect(rows[1]).toMatchObject({ provider: 'claude', totalTokens: 3_600, costUsd: 0.42 })
    expect(rows[2]).toMatchObject({ provider: 'muse', totalTokens: 75, costUsd: null })
    expect(rows[2].reasoningTokens).toBe(0)
  })

  it('breaks total-token ties by provider then model so ordering is stable', () => {
    const rows = buildUsageDashboardModelRows([
      {
        id: 'muse',
        rows: [
          { model: 'b', inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
        ]
      },
      {
        id: 'claude',
        rows: [
          { model: 'z', inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          { model: 'a', inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
        ]
      }
    ])

    expect(rows.map((row) => `${row.provider}:${row.model}`)).toEqual([
      'claude:a',
      'claude:z',
      'muse:b'
    ])
  })

  it('returns an empty list when no provider reported models', () => {
    expect(buildUsageDashboardModelRows([])).toEqual([])
  })
})
