import type { UsageHistoryRow } from './usage-history-types'

export type UsageHistoryTotals = {
  totalTokens: number
  newInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  apiEquivalentCostUsd: number | null
  unpricedTokens: number
  hasPartialCost: boolean
  sessions: number | null
}

export type UsageHistoryGroup = UsageHistoryTotals & {
  key: string
  label: string
  rows: UsageHistoryRow[]
}

export function totalUsageHistory(rows: readonly UsageHistoryRow[]): UsageHistoryTotals {
  let totalTokens = 0
  let newInputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let cost = 0
  let hasCost = false
  let unpricedTokens = 0
  let missingSessions = false
  const sessions = new Set<string>()
  for (const row of rows) {
    totalTokens += row.totalTokens
    newInputTokens += row.newInputTokens
    cacheReadTokens += row.cacheReadTokens
    cacheWriteTokens += row.cacheWriteTokens
    outputTokens += row.outputTokens
    if (row.apiEquivalentCostUsd === null) {
      unpricedTokens += row.totalTokens
    } else {
      hasCost = true
      cost += row.apiEquivalentCostUsd
    }
    if (row.sessionId) {
      sessions.add(`${row.provider}:${row.sessionId}`)
    } else {
      missingSessions = true
    }
  }
  return {
    totalTokens,
    newInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    apiEquivalentCostUsd: hasCost ? cost : null,
    unpricedTokens,
    hasPartialCost: hasCost && unpricedTokens > 0,
    sessions: missingSessions ? null : sessions.size
  }
}

export function groupUsageHistory(
  rows: readonly UsageHistoryRow[],
  kind: 'day' | 'model' | 'project' | 'session' | 'account',
  unknownLabel: string
): UsageHistoryGroup[] {
  const groups = new Map<string, { label: string; rows: UsageHistoryRow[] }>()
  for (const row of rows) {
    const key =
      kind === 'day'
        ? row.day
        : kind === 'model'
          ? (row.model ?? 'unknown')
          : kind === 'project'
            ? row.projectKey
            : kind === 'account'
              ? row.accountId
                ? JSON.stringify([row.provider, row.accountId])
                : 'unknown'
              : `${row.provider}:${row.sessionId ?? 'unknown'}`
    const label =
      kind === 'model'
        ? (row.model ?? unknownLabel)
        : kind === 'project'
          ? row.projectLabel
          : kind === 'account'
            ? (row.accountId ?? unknownLabel)
            : kind === 'session'
              ? (row.sessionId ?? unknownLabel)
              : key
    const group = groups.get(key) ?? { label, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  const result = [...groups].map(([key, group]) => ({
    key,
    ...group,
    ...totalUsageHistory(group.rows)
  }))
  return result.sort((a, b) =>
    kind === 'day' ? a.key.localeCompare(b.key) : b.totalTokens - a.totalTokens
  )
}
