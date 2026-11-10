import { describe, expect, it } from 'vitest'
import { formatRelative } from './cloud-workspace-format'

const NOW = 1_800_000_000_000
const t = (_key: string, fallback: string): string => fallback

describe('formatRelative', () => {
  it('says "just now" under 45 seconds', () => {
    expect(formatRelative(NOW - 30_000, NOW, t, 'en')).toBe('just now')
  })

  it('uses Intl.RelativeTimeFormat for minutes, hours and days', () => {
    expect(formatRelative(NOW - 5 * 60_000, NOW, t, 'en')).toBe('5m ago')
    expect(formatRelative(NOW - 3 * 3_600_000, NOW, t, 'en')).toBe('3h ago')
    expect(formatRelative(NOW - 2 * 86_400_000, NOW, t, 'en')).toBe('2d ago')
  })

  it('follows the UI locale rather than an English template', () => {
    const expected = new Intl.RelativeTimeFormat('de', { numeric: 'always', style: 'narrow' })
    expect(formatRelative(NOW - 5 * 60_000, NOW, t, 'de')).toBe(expected.format(-5, 'minute'))
    expect(formatRelative(NOW - 5 * 60_000, NOW, t, 'de')).not.toContain('ago')
  })

  it('falls back to a date after 30 days', () => {
    const at = NOW - 40 * 86_400_000
    expect(formatRelative(at, NOW, t, 'en')).toBe(new Intl.DateTimeFormat('en').format(at))
  })
})
