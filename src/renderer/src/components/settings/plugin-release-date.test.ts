import { describe, expect, it } from 'vitest'
import { formatPluginReleaseDate } from './plugin-release-date'

describe('formatPluginReleaseDate', () => {
  it('keeps a bare date on its own day in every time zone', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(Date.UTC(2026, 9, 20))
    expect(formatPluginReleaseDate('2026-10-20')).toBe(expected)
  })

  it('returns null for a missing or unreadable date', () => {
    expect(formatPluginReleaseDate(undefined)).toBeNull()
    expect(formatPluginReleaseDate('soon')).toBeNull()
  })
})
