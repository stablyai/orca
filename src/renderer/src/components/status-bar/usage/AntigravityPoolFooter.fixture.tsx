import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { StatusBarUsageMode } from '../../../../../shared/status-bar/status-bar-usage-mode'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { ProviderSegment } from './StatusBarProviderSegment'

const NOW = Date.now()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function win(usedPercent: number, windowMinutes: number, resetsInMs: number): RateLimitWindow {
  return {
    usedPercent,
    windowMinutes,
    resetsAt: NOW + resetsInMs + 5_000,
    resetDescription: null
  }
}

function pools(sessionUsed: number, weeklyUsed: number): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: NOW - 30_000,
    error: null,
    status: 'ok',
    buckets: [
      { ...win(sessionUsed, 300, 3 * HOUR + 47 * MIN), name: 'Gemini 5h', group: 'Gemini models' },
      {
        ...win(weeklyUsed, 10_080, 6 * DAY + 7 * HOUR),
        name: 'Gemini weekly',
        group: 'Gemini models'
      }
    ]
  }
}

function unknownWindowPools(): ProviderRateLimits {
  return {
    ...pools(18, 9),
    buckets: [
      {
        usedPercent: 9,
        windowMinutes: 0,
        resetsAt: null,
        resetDescription: null,
        windowName: 'Weekly Limit Remaining',
        name: 'Gemini weekly',
        group: 'Gemini models'
      }
    ]
  }
}

function footer(p: ProviderRateLimits, display: UsagePercentageDisplay, mode: StatusBarUsageMode) {
  return defineFixture({
    width: 480,
    store: { usagePercentageDisplay: display, statusBarUsageMode: mode },
    render: () => (
      <div className="flex h-[120px] items-start bg-background p-3">
        <div className="flex items-center gap-x-3 whitespace-nowrap rounded border border-border px-2 py-1 text-xs">
          <ProviderSegment p={p} display={display} mode={mode} />
        </div>
      </div>
    )
  })
}

// Why: the reported footer shows 82%/91% left, where the 80%-used gate hides both countdowns.
export const rosterAntigravityPoolsLeft = footer(pools(18, 9), 'remaining', 'verbose')
export const rosterAntigravityPools = footer(pools(82, 91), 'used', 'verbose')
export const rosterAntigravityPoolsCompact = footer(pools(18, 9), 'remaining', 'compact')
export const rosterAntigravityPoolUnknownWindow = footer(
  unknownWindowPools(),
  'remaining',
  'verbose'
)
