import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { ProviderSegment } from './StatusBarProviderSegment'
import { selectStatusBarProviderWindows } from './status-bar-provider-windows'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))

const limits: ProviderRateLimits = {
  provider: 'claude',
  session: { usedPercent: 90, windowMinutes: 300, resetsAt: null, resetDescription: null },
  weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null, resetDescription: null },
  updatedAt: 0,
  error: null,
  status: 'ok'
}

describe('footer window selection', () => {
  it.each(['claude', 'codex'] as const)(
    'filters %s labels and summary bars to the selected window',
    (provider) => {
      for (const windows of ['session', 'weekly'] as const) {
        for (const mode of ['verbose', 'compact'] as const) {
          for (const compact of [false, true]) {
            for (const display of ['used', 'remaining'] as const) {
              const markup = renderToStaticMarkup(
                <ProviderSegment
                  p={{ ...limits, provider }}
                  compact={compact}
                  display={display}
                  mode={mode}
                  windows={windows}
                />
              )
              const used = windows === 'session' ? 90 : 40
              const otherUsed = windows === 'session' ? 40 : 90
              const shown = display === 'used' ? used : 100 - used
              const hidden = display === 'used' ? otherUsed : 100 - otherUsed
              const suffix = display === 'used' ? 'used' : 'left'
              expect(markup).toContain(`${shown}% ${suffix}`)
              expect(markup).not.toContain(`${hidden}% ${suffix}`)
              if (mode === 'verbose' && !compact) {
                expect(markup).toContain(`width:${shown}%`)
              }
            }
          }
        }
      }
    }
  )

  it('keeps both windows by default and respects remaining percentages', () => {
    const markup = renderToStaticMarkup(
      <ProviderSegment p={limits} compact={false} display="remaining" />
    )
    expect(markup).toContain('10% left')
    expect(markup).toContain('60% left')
    expect(selectStatusBarProviderWindows(limits, 'both')).toBe(limits)
  })

  it('does not fall back to a hidden window while fetching or using stale data', () => {
    for (const status of ['ok', 'fetching', 'error'] as const) {
      const markup = renderToStaticMarkup(
        <ProviderSegment
          p={{ ...limits, weekly: null, status }}
          compact={false}
          display="used"
          windows="weekly"
        />
      )
      expect(markup).toContain('--')
      expect(markup).not.toContain('90%')
      expect(markup).not.toContain('···')
    }
  })

  it('includes model-specific weekly limits without mutating the detail snapshot', () => {
    const provider = { ...limits, fableWeekly: { ...limits.weekly!, usedPercent: 70 } }
    const weekly = selectStatusBarProviderWindows(provider, 'weekly')
    expect(weekly.session).toBeNull()
    expect(weekly.fableWeekly).toBe(provider.fableWeekly)
    expect(selectStatusBarProviderWindows(provider, 'session').fableWeekly).toBeNull()
    expect(provider.session).toBe(limits.session)
  })

  it('preserves monthly-only and named-bucket providers', () => {
    const monthly: ProviderRateLimits = {
      ...limits,
      provider: 'grok',
      session: null,
      weekly: null,
      monthly: { ...limits.session!, windowMinutes: 43200 }
    }
    const buckets: ProviderRateLimits = {
      ...limits,
      provider: 'gemini',
      buckets: [{ ...limits.session!, name: 'Pro' }]
    }
    for (const windows of ['session', 'weekly'] as const) {
      expect(selectStatusBarProviderWindows(monthly, windows)).toBe(monthly)
      expect(selectStatusBarProviderWindows(buckets, windows)).toBe(buckets)
    }
  })
})
