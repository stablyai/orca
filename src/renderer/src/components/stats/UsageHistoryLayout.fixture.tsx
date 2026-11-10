import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import type { UsageHistoryRow } from '../../../../shared/usage-history-types'
import { UsageHistoryBreakdowns, UsageHistoryDailyChart } from './UsageHistoryDetails'
import { usageHistoryAccountKey } from './usage-history-model'

const rows: UsageHistoryRow[] = Array.from({ length: 10 }, (_, index) => [
  {
    provider: 'claude' as const,
    day: `2026-11-${String(index + 1).padStart(2, '0')}`,
    sessionId: `claude-${index}`,
    accountId: 'claude-main',
    model: index % 3 ? 'claude-opus-5-5' : 'claude-sonnet-5-5',
    projectKey: index % 2 ? 'acme' : 'checkout',
    projectLabel: index % 2 ? 'Acme application' : 'Checkout service',
    inOrca: true,
    activityCount: 2,
    newInputTokens: 900_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 100_000_000,
    reasoningTokens: 0,
    totalTokens: 1_000_000_000 + index * 50_000_000,
    apiEquivalentCostUsd: 170 + index
  },
  {
    provider: 'codex' as const,
    day: `2026-11-${String(index + 1).padStart(2, '0')}`,
    sessionId: `codex-${index}`,
    accountId: 'codex-main',
    model: 'gpt-6.1-sol',
    projectKey: 'platform',
    projectLabel: 'Developer platform',
    inOrca: true,
    activityCount: 2,
    newInputTokens: 400_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 100_000_000,
    reasoningTokens: 0,
    totalTokens: 500_000_000 + (9 - index) * 70_000_000,
    apiEquivalentCostUsd: 70 + index
  }
]).flat()
const labels = new Map([
  [
    usageHistoryAccountKey({ provider: 'claude', accountId: 'claude-main' }),
    'Claude · developer@example.com (Personal)'
  ],
  [
    usageHistoryAccountKey({ provider: 'codex', accountId: 'codex-main' }),
    'Codex · developer@example.com (Team plan)'
  ]
])
const settings = { ...getDefaultSettings('/projects/acme'), uiLanguage: 'en' as const }
async function hover(frame: HTMLElement) {
  const button = frame.querySelector<HTMLButtonElement>('[aria-label^="2026-11-06:"]')
  if (!button) {
    throw new Error('Daily chart day missing')
  }
  const bounds = button.getBoundingClientRect()
  const init = { bubbles: true, clientX: bounds.left + bounds.width / 2, clientY: bounds.top + 80 }
  button.dispatchEvent(new MouseEvent('mouseover', init))
  button.dispatchEvent(new MouseEvent('mousemove', init))
}
function Breakdown() {
  return (
    <div className="@container p-4">
      <UsageHistoryBreakdowns
        rows={rows}
        accountLabels={labels}
        onAccount={() => {}}
        onModel={() => {}}
        onProject={() => {}}
      />
    </div>
  )
}
function Chart() {
  return (
    <div className="@container p-4">
      <UsageHistoryDailyChart
        rows={rows}
        range="30d"
        selectedDay={null}
        today="2026-11-10"
        onDay={() => {}}
      />
    </div>
  )
}
export const breakdowns = defineFixture({
  width: 760,
  store: { settings },
  render: () => <Breakdown />
})
export const breakdownsNarrow = defineFixture({
  width: 390,
  store: { settings },
  render: () => <Breakdown />
})
export const chart = defineFixture({
  width: 760,
  store: { settings },
  render: () => <Chart />,
  interact: hover
})
export const chartNarrow = defineFixture({
  width: 390,
  store: { settings },
  render: () => <Chart />,
  interact: hover
})
