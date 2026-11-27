import { defineFixture } from '../../../component-fixtures/component-fixture'
import { setRendererUiLanguage } from '@/i18n/i18n'
import type {
  ProviderRateLimits,
  RateLimitWindow
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { StatusBarUsageMode } from '../../../../../shared/status-bar/status-bar-usage-mode'
import { ProviderSegment } from './StatusBarProviderSegment'
import { UsageUnitLabel } from './usage-unit-label'

const NOW = Date.now()
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

function win(usedPercent: number, windowMinutes: number, resetsInMs: number): RateLimitWindow {
  return { usedPercent, windowMinutes, resetsAt: NOW + resetsInMs, resetDescription: null }
}

function provider(
  id: ProviderRateLimits['provider'],
  windows: Partial<ProviderRateLimits>
): ProviderRateLimits {
  return {
    provider: id,
    session: null,
    weekly: null,
    updatedAt: NOW - 30_000,
    error: null,
    status: 'ok',
    ...windows
  }
}

// Seeded fake readings at a calm, a nearly spent and a spent level, plus a Fable-only reading.
function providersAt(level: number): ProviderRateLimits[] {
  return [
    provider('claude', {
      session: win(level, 300, 3 * HOUR),
      weekly: win(Math.max(0, level - 20), 10_080, 4 * DAY),
      fableWeekly: win(level, 10_080, 4 * DAY)
    }),
    provider('codex', { session: win(18, 300, 2 * HOUR), weekly: win(level, 10_080, 6 * DAY) }),
    provider('grok', { weekly: win(level, 10_080, 6 * DAY) })
  ]
}

const FABLE_ONLY = provider('claude', { fableWeekly: win(100, 10_080, 4 * DAY) })

const ROWS: { label: string; providers: ProviderRateLimits[] }[] = [
  { label: '39%', providers: providersAt(39) },
  { label: '86%', providers: providersAt(86) },
  { label: '98%', providers: providersAt(98) },
  { label: 'Fable only', providers: [FABLE_ONLY] }
]

function levelsFixture(mode: StatusBarUsageMode, compactResetCountdown = false) {
  return defineFixture({
    width: 960,
    store: { statusBarUsageFormat: { template: '', compactResetCountdown } },
    interact: () => setRendererUiLanguage('en'),
    render: () => (
      <div className="flex flex-col gap-2 bg-background p-3 text-xs">
        {ROWS.flatMap((row) =>
          [false, true].map((compact) => (
            <div
              key={`${row.label}-${compact}`}
              className="flex items-center gap-3 whitespace-nowrap rounded border border-border px-2 py-1"
            >
              <span className="w-32 shrink-0 text-muted-foreground">{`${row.label} · ${compact ? 'narrow' : 'normal'}`}</span>
              {mode === 'compact' ? <UsageUnitLabel display="used" compact /> : null}
              {row.providers.map((p) => (
                <ProviderSegment
                  key={p.provider}
                  p={p}
                  compact={compact}
                  display="used"
                  mode={mode}
                />
              ))}
            </div>
          ))
        )}
      </div>
    )
  })
}

export const detailed = levelsFixture('verbose')
export const compact = levelsFixture('compact')
export const compactWithResetCountdown = levelsFixture('compact', true)
