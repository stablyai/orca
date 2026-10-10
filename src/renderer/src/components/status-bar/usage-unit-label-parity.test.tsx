import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { ProviderSegment } from './StatusBarProviderSegment'
import { UsageUnitLabel, usageChipShowsPercentage } from './usage-unit-label'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values: Record<string, string> = {}) =>
    Object.entries(values).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/hooks/useResetCountdownClock', () => ({ useResetCountdownClock: () => 0 }))
vi.mock('@/components/ui/dropdown-menu', () => ({ DropdownMenuItem: () => null }))
vi.mock('@/components/settings/SettingsFormControls', () => ({
  SettingsSegmentedControl: () => null
}))

function windowOf(usedPercent: number, windowMinutes = 300): RateLimitWindow {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
}

function limits(
  provider: ProviderRateLimits['provider'],
  status: ProviderRateLimits['status'],
  rest: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return { provider, session: null, weekly: null, updatedAt: 0, error: null, status, ...rest }
}

const fixtures: [string, ProviderRateLimits | null][] = [
  ['missing', null],
  ['idle', limits('claude', 'idle', { session: windowOf(5) })],
  ['fetching without data', limits('claude', 'fetching')],
  ['fetching with data', limits('claude', 'fetching', { session: windowOf(5) })],
  ['unavailable', limits('codex', 'unavailable')],
  ['error without data', limits('codex', 'error')],
  ['error with stale data', limits('codex', 'error', { weekly: windowOf(40, 10_080) })],
  ['monthly only', limits('grok', 'ok', { monthly: windowOf(25, 43_200) })],
  ['fable only', limits('claude', 'ok', { fableWeekly: windowOf(30, 10_080) })],
  [
    'filtered buckets without fallback',
    limits('gemini', 'ok', {
      buckets: [{ ...windowOf(30), name: 'Experimental' }]
    })
  ],
  [
    'filtered buckets with fallback',
    limits('gemini', 'ok', {
      weekly: windowOf(10, 10_080),
      buckets: [{ ...windowOf(30), name: 'Experimental' }]
    })
  ],
  ['visible bucket', limits('gemini', 'ok', { buckets: [{ ...windowOf(0), name: 'Pro' }] })],
  [
    'antigravity pools',
    limits('antigravity', 'ok', {
      buckets: [{ ...windowOf(4, 10_080), name: 'Gemini Models' }]
    })
  ],
  [
    'capped with extra usage',
    limits('codex', 'ok', {
      session: windowOf(100),
      extraUsage: {
        unit: 'credits',
        enabled: true,
        disabledReason: null,
        resetsAt: null,
        unlimited: false,
        balance: 12
      }
    })
  ]
]

describe('usageChipShowsPercentage parity with ProviderSegment', () => {
  for (const mode of ['verbose', 'compact'] as const) {
    for (const compact of [false, true]) {
      it.each(fixtures)(`%s (mode=${mode}, compact=${compact})`, (_name, p) => {
        // The MiniBar's inline width style contains "%" and isn't a rendered percentage.
        const markup = renderToStaticMarkup(
          <ProviderSegment p={p} compact={compact} display="used" mode={mode} />
        ).replace(/style="[^"]*"/g, '')
        expect(usageChipShowsPercentage(p, mode)).toBe(markup.includes('%'))
      })
    }
  }
})

describe('UsageUnitLabel', () => {
  it('names the chosen display and stays mounted while collapsed', () => {
    expect(renderToStaticMarkup(<UsageUnitLabel collapsed={false} display="used" />)).toContain(
      '>Used<'
    )
    const collapsed = renderToStaticMarkup(<UsageUnitLabel collapsed display="remaining" />)
    expect(collapsed).toContain('>Remaining<')
    expect(collapsed).toContain('data-usage-collapsed="true"')
    expect(collapsed).toContain('aria-hidden="true"')
  })
})
