import { expect, it } from 'vitest'
import type { UsageHistoryRow } from '../../../../shared/usage-history-types'
import { usageHistoryChartDays } from './usage-history-model'
import { usageHistoryProviderSeries, usageHistoryLineSegments } from './usage-history-chart-model'

function row(day: string, patch: Partial<UsageHistoryRow> = {}): UsageHistoryRow {
  return {
    provider: 'claude',
    day,
    sessionId: day,
    model: 'sonnet',
    projectKey: 'folder',
    projectLabel: 'Folder',
    inOrca: true,
    newInputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
    reasoningTokens: 0,
    activityCount: 1,
    totalTokens: 110,
    apiEquivalentCostUsd: 0.01,
    ...patch
  }
}

it('connects inactive days at zero while keeping unknown prices distinct from zero cost', () => {
  const days = usageHistoryChartDays(
    [
      row('2026-10-21'),
      row('2026-10-22'),
      row('2026-10-24', { apiEquivalentCostUsd: null }),
      row('2026-10-25', { apiEquivalentCostUsd: 0 }),
      row('2026-10-23', { provider: 'codex', totalTokens: 500 })
    ],
    '7d',
    null,
    new Date(2026, 9, 25, 12)
  )
  const tokens = usageHistoryProviderSeries(days, 'tokens')
  const claude = tokens.find((series) => series.provider === 'claude')
  expect(claude?.points.map((point) => point.amount)).toEqual([0, 0, 110, 110, 0, 110, 110])
  expect(
    usageHistoryLineSegments(claude?.points ?? []).map((segment) =>
      segment.map((point) => days[point.index].day)
    )
  ).toEqual([
    [
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25'
    ]
  ])
  const cost = usageHistoryProviderSeries(days, 'cost').find(
    (series) => series.provider === 'claude'
  )
  expect(cost?.points.map((point) => point.amount)).toEqual([0, 0, 0.01, 0.01, 0, null, 0])
  expect(usageHistoryLineSegments(cost?.points ?? []).map((segment) => segment.length)).toEqual([
    5, 1
  ])
})

it('keeps provider totals coherent with the daily ledger and labels mixed prices partial', () => {
  const days = usageHistoryChartDays(
    [
      row('2026-10-25'),
      row('2026-10-25', { apiEquivalentCostUsd: null }),
      row('2026-10-25', { provider: 'codex', totalTokens: 250 })
    ],
    'all',
    null,
    new Date(2026, 9, 25, 12)
  )
  const series = usageHistoryProviderSeries(days, 'cost')
  expect(series.find((series) => series.provider === 'claude')?.points[0]).toMatchObject({
    amount: 0.01,
    usage: { totalTokens: 220, hasPartialCost: true, unpricedTokens: 110 }
  })
  expect(
    series.reduce((total, series) => total + (series.points[0].usage?.totalTokens ?? 0), 0)
  ).toBe(days[0].usage?.totalTokens)
})
