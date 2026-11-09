import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { buildUsageFormatValues, renderUsageFormatTemplate } from './usage-format-template'

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0)

/** Rate-limit window fixture. */
function win(
  usedPercent: number,
  windowMinutes: number,
  resetInMs: number | null
): RateLimitWindow {
  return {
    usedPercent,
    windowMinutes,
    resetsAt: resetInMs === null ? null : NOW + resetInMs,
    resetDescription: null
  }
}

/** Provider limits fixture with overridable fields. */
function provider(overrides: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: NOW,
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('renderUsageFormatTemplate', () => {
  it('substitutes known placeholders and leaves unknown ones verbatim', () => {
    expect(
      renderUsageFormatTemplate('{provider}: {5h} {nope}', { provider: 'Claude', '5h': '14%' })
    ).toBe('Claude: 14% {nope}')
  })

  it('drops an optional group when any placeholder inside is empty', () => {
    const values = { provider: 'Grok', '5h': '', '7d': '19%' }
    expect(renderUsageFormatTemplate('{provider}[ | 5h: {5h}][ | 7d: {7d}]', values)).toBe(
      'Grok | 7d: 19%'
    )
  })

  it('keeps an optional group whose placeholders all resolve', () => {
    expect(
      renderUsageFormatTemplate('[{5h} ({5h.reset})]', { '5h': '14%', '5h.reset': '3h 15m' })
    ).toBe('14% (3h 15m)')
  })

  it('keeps bracket text that contains no placeholders as literal', () => {
    expect(renderUsageFormatTemplate('[x] {5h}', { '5h': '14%' })).toBe('[x] 14%')
  })

  it("preserves the author's spacing and removes only the dropped group text", () => {
    expect(
      renderUsageFormatTemplate('{provider}   [{5h}] [{7d}] end  ', {
        provider: 'A',
        '5h': '',
        '7d': ''
      })
    ).toBe('A     end  ')
  })
})

describe('buildUsageFormatValues', () => {
  it('exposes provider, window percentages, reset countdowns and clock times', () => {
    const values = buildUsageFormatValues(
      provider({
        session: win(14, 300, 3 * 60 * 60 * 1000 + 15 * 60 * 1000),
        weekly: win(20, 10080, (2 * 24 + 15) * 60 * 60 * 1000),
        fableWeekly: win(37, 10080, 24 * 60 * 60 * 1000)
      }),
      { display: 'used', now: NOW, timeZone: 'UTC' }
    )

    expect(values).toMatchObject({
      provider: 'Claude',
      plan: '',
      '5h': '14%',
      '5h.reset': '3h 15m',
      '5h.resetAt': '15:15',
      '7d': '20%',
      '7d.reset': '2d 15h',
      fable: '37%',
      'fable.reset': '1d',
      '30d': '',
      '30d.reset': '',
      '30d.resetAt': '',
      buckets: ''
    })
  })

  it('shows remaining percentages when the display setting says so', () => {
    const values = buildUsageFormatValues(provider({ session: win(14, 300, null) }), {
      display: 'remaining',
      now: NOW,
      timeZone: 'UTC'
    })
    expect(values['5h']).toBe('86%')
    expect(values['5h.reset']).toBe('')
    expect(values['5h.resetAt']).toBe('')
  })

  it('exposes the Codex plan and the monthly window', () => {
    const values = buildUsageFormatValues(
      provider({ provider: 'codex', planType: 'plus', monthly: win(4, 43200, null) }),
      { display: 'used', now: NOW, timeZone: 'UTC' }
    )
    expect(values.provider).toBe('Codex')
    expect(values.plan).toBe('Plus')
    expect(values['30d']).toBe('4%')
  })

  it('joins Gemini buckets in the status bar order', () => {
    const values = buildUsageFormatValues(
      provider({
        provider: 'gemini',
        buckets: [
          { ...win(40, 300, null), name: 'Pro' },
          { ...win(12, 300, null), name: 'Flash' },
          { ...win(1, 300, null), name: 'Other' }
        ]
      }),
      { display: 'used', now: NOW, timeZone: 'UTC' }
    )
    expect(values.buckets).toBe('Flash 12% · Pro 40%')
  })
})
