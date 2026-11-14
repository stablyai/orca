import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ locale: 'en-US' }))
vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => state.locale,
  translate: (_key: string, fallback: string) => fallback
}))

import {
  formatCost,
  formatSessionTime,
  formatTokens,
  formatUsageDayLabel
} from './usage-formatters'

afterEach(() => {
  state.locale = 'en-US'
})

it('uses Russian compact units and decimal precision for small estimated costs', () => {
  state.locale = 'ru'
  expect(formatTokens(1200)).toMatch(/^1,2\s+тыс\.?$/)
  expect(formatTokens(36_700_000_000)).toMatch(/^36,7\s+млрд\.?$/)
  expect(formatCost(0.0042)).toMatch(/^0,0042\s+\$$/)
  expect(formatCost(1.234)).toMatch(/^1,23\s+\$$/)
})

it('formats session dates with the selected language and preserves an unreadable timestamp', () => {
  state.locale = 'ru'
  const input = '2026-10-24T10:30:00Z'
  expect(formatSessionTime(input)).toBe(
    new Date(input).toLocaleString('ru', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  )
  expect(formatSessionTime('not a timestamp')).toBe('not a timestamp')
})

it('uses the selected language for calendar days without shifting the recorded date', () => {
  state.locale = 'ru'
  expect(formatUsageDayLabel('2026-10-24')).toBe('24 окт.')
  state.locale = 'en-US'
  expect(formatUsageDayLabel('2026-10-24')).toBe('Oct 24')
  expect(formatUsageDayLabel('not a day')).toBe('not a day')
})
