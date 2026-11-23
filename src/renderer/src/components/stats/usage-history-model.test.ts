import { describe, expect, it } from 'vitest'
import type { UsageHistoryRow } from '../../../../shared/usage-history-types'
import {
  filterUsageHistory,
  formatCacheReadShare,
  groupUsageHistory,
  totalUsageHistory,
  usageHistoryChartDays,
  usageHistoryAccountKey,
  type UsageHistorySelection
} from './usage-history-model'

const now = new Date(2026, 9, 24, 12)
const selection: UsageHistorySelection = {
  range: '7d',
  scope: 'all',
  provider: 'all',
  model: null,
  project: null,
  day: null
}
function row(patch: Partial<UsageHistoryRow> = {}): UsageHistoryRow {
  return {
    provider: 'codex',
    day: '2026-10-24',
    sessionId: 'session-1',
    model: 'gpt-5.4',
    projectKey: 'folder',
    projectLabel: 'Folder',
    inOrca: true,
    activityCount: 1,
    newInputTokens: 100,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
    outputTokens: 200,
    reasoningTokens: 150,
    totalTokens: 1200,
    apiEquivalentCostUsd: 0.01,
    ...patch
  }
}

describe('one historical usage selection', () => {
  it('uses one account-filtered set for totals, chart, model/project and session drilldown without absorbing legacy rows', () => {
    const history = [
      row({ accountId: 'work' }),
      row({ accountId: 'work', day: '2026-10-23' }),
      row({ accountId: 'personal' }),
      row(),
      row({ accountId: null }),
      row({ provider: 'claude', accountId: 'work' })
    ]
    const selected = filterUsageHistory(
      history,
      { ...selection, account: usageHistoryAccountKey(history[0]) },
      now
    )
    const total = totalUsageHistory(selected)
    expect(selected).toHaveLength(2)
    expect(total).toMatchObject({
      totalTokens: 2400,
      sessions: 1,
      cacheReadTokens: 1800,
      outputTokens: 400
    })
    for (const kind of ['account', 'day', 'model', 'project', 'session'] as const) {
      expect(
        groupUsageHistory(selected, kind, 'Unknown').reduce(
          (sum, group) => sum + group.totalTokens,
          0
        )
      ).toBe(total.totalTokens)
    }
    expect(
      usageHistoryChartDays(selected, '7d', null, now).reduce(
        (sum, day) => sum + (day.usage?.totalTokens ?? 0),
        0
      )
    ).toBe(total.totalTokens)
    expect(filterUsageHistory(history, { ...selection, account: 'unknown' }, now)).toHaveLength(2)
  })
  it('keeps empty calendar slots separate from recorded ledger rows', () => {
    const days = usageHistoryChartDays([row()], '7d', null, now)
    expect(days).toHaveLength(7)
    expect(days[0]).toEqual({ day: '2026-10-18', usage: null })
    expect(days.at(-1)?.usage?.totalTokens).toBe(1200)
    expect(usageHistoryChartDays([row()], '7d', '2026-10-24', now)).toHaveLength(1)
  })

  it('shares inclusive local-calendar period, provider, model, project, day and folder scope across projections', () => {
    const history = [
      row({ day: '2026-10-17' }),
      row({ day: '2026-10-18' }),
      row(),
      row({ day: '2026-10-25' }),
      row({ projectKey: 'other' }),
      row({ model: 'gpt-6-astra' }),
      row({ provider: 'claude' }),
      row({ inOrca: false })
    ]
    const selected = filterUsageHistory(
      history,
      { ...selection, scope: 'orca', provider: 'codex', model: 'gpt-5.4', project: 'folder' },
      now
    )
    expect(selected.map((entry) => entry.day)).toEqual(['2026-10-18', '2026-10-24'])
    const total = totalUsageHistory(selected)
    expect(total.totalTokens).toBe(2400)
    for (const kind of ['day', 'model', 'project', 'session'] as const) {
      const groups = groupUsageHistory(selected, kind, 'Unknown')
      expect(groups.reduce((sum, group) => sum + group.totalTokens, 0)).toBe(total.totalTokens)
      expect(groups.reduce((sum, group) => sum + (group.apiEquivalentCostUsd ?? 0), 0)).toBeCloseTo(
        total.apiEquivalentCostUsd ?? 0
      )
    }
    const dayOnly = filterUsageHistory(selected, { ...selection, day: '2026-10-18' }, now)
    expect(totalUsageHistory(dayOnly).totalTokens).toBe(1200)
    expect(groupUsageHistory(dayOnly, 'session', 'Unknown')[0]?.totalTokens).toBe(1200)
  })

  it.each([
    ['7d', '2026-10-18'],
    ['30d', '2026-09-25'],
    ['90d', '2026-07-27'],
    ['all', '2020-01-01']
  ] as const)('uses the same %s cutoff for every provider', (range, start) => {
    const rows = ['claude', 'codex', 'opencode', 'muse'].flatMap((provider) => {
      if (
        provider !== 'claude' &&
        provider !== 'codex' &&
        provider !== 'opencode' &&
        provider !== 'muse'
      ) {
        return []
      }
      return [row({ provider, day: start }), row({ provider, day: '2020-01-01' })]
    })
    expect(filterUsageHistory(rows, { ...selection, range }, now)).toHaveLength(
      range === 'all' ? 8 : 4
    )
  })

  it('marks mixed pricing partial, all missing prices unavailable, and missing sessions unknown', () => {
    expect(
      totalUsageHistory([
        row(),
        row({ provider: 'muse', sessionId: null, apiEquivalentCostUsd: null })
      ])
    ).toMatchObject({
      totalTokens: 2400,
      apiEquivalentCostUsd: 0.01,
      unpricedTokens: 1200,
      hasPartialCost: true,
      sessions: null
    })
    expect(totalUsageHistory([row({ apiEquivalentCostUsd: null })])).toMatchObject({
      apiEquivalentCostUsd: null,
      hasPartialCost: false
    })
    expect(totalUsageHistory([row({ apiEquivalentCostUsd: 0 })]).apiEquivalentCostUsd).toBe(0)
  })

  it('uses all disjoint input buckets for cache share and never rounds partial reuse to 100%', () => {
    expect(
      formatCacheReadShare(
        totalUsageHistory([
          row({ newInputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 })
        ])
      )
    ).toBe('80.0%')
    expect(
      formatCacheReadShare(totalUsageHistory([row({ newInputTokens: 1, cacheReadTokens: 99999 })]))
    ).toBe('<100%')
    expect(formatCacheReadShare(totalUsageHistory([]))).toBe('n/a')
    expect(
      formatCacheReadShare(
        totalUsageHistory([
          row({ newInputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 })
        ]),
        'ru',
        'н/д'
      )
    ).toBe('80,0%')
    expect(formatCacheReadShare(totalUsageHistory([]), 'ru', 'н/д')).toBe('н/д')
  })
})

it('uses the host calendar when it is ahead of or behind the client across midnight', () => {
  const history = [
    row({ day: '2026-10-18' }),
    row({ day: '2026-10-19' }),
    row({ day: '2026-10-25' })
  ]
  const ahead = { ...selection, today: '2026-10-25' }
  const selected = filterUsageHistory(history, ahead, now)
  expect(selected.map((row) => row.day)).toEqual(['2026-10-19', '2026-10-25'])
  expect(usageHistoryChartDays(selected, '7d', null, now, ahead.today).at(-1)?.day).toBe(
    '2026-10-25'
  )
  const behind = { ...selection, today: '2026-10-23' }
  expect(filterUsageHistory([row({ day: '2026-10-17' })], behind, now)).toHaveLength(1)
  expect(filterUsageHistory(history, { ...ahead, range: 'all' }, now)).toHaveLength(3)
})

it('keeps all-time host rows visible with older snapshots that lack a host calendar', () => {
  expect(
    filterUsageHistory([row({ day: '2026-10-25' })], { ...selection, range: 'all' }, now)
  ).toHaveLength(1)
})
