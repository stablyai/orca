import { expect, it } from 'vitest'
import { summarizeContextUsage, groupContextUsageRows } from './native-chat-context-usage-summary'

it('keeps deferred definitions outside the used-context breakdown on both clients', () => {
  const summary = summarizeContextUsage({
    usedTokens: 607_700,
    windowTokens: 1_000_000,
    percentage: 61,
    estimated: false,
    categories: [
      { name: 'MCP tools', tokens: 542_000, deferred: true },
      { name: 'System prompt', tokens: 18_700 },
      { name: 'Messages', tokens: 589_000 },
      { name: 'System tools', tokens: 17_000, deferred: true },
      { name: 'Empty', tokens: 0, deferred: true }
    ]
  })
  expect(summary.rows).toEqual([
    { name: 'Messages', tokens: 589_000, percentage: 58.9 },
    { name: 'MCP tools', tokens: 542_000, percentage: 54.2, deferred: true },
    { name: 'System prompt', tokens: 18_700, percentage: 1.9 },
    { name: 'System tools', tokens: 17_000, percentage: 1.7, deferred: true }
  ])
  const groups = groupContextUsageRows(summary.rows)
  expect(groups.used.map(({ row }) => row.tokens)).toEqual([589_000, 18_700])
  expect(groups.used.reduce((total, { row }) => total + row.tokens, 0)).toBe(607_700)
  expect(groups.deferred.map(({ row }) => row.tokens)).toEqual([542_000, 17_000])
  expect(summary.usedTokens).toBe(607_700)
})
