import { describe, expect, it } from 'vitest'
import { readAntigravityStatusLineQuota } from '../../../../../shared/agent-usage/rate-limits/antigravity-statusline-quota'
import { getStatusBarUsageSections } from './status-bar-usage-sections'

const NOW = Date.parse('2026-11-28T10:00:00Z')

function reading(quota: Record<string, { remaining_fraction: number; reset_time: string }>) {
  const result = readAntigravityStatusLineQuota({ quota }, NOW)
  if (!result) {
    throw new Error('fixture has no usable pool')
  }
  return result
}

describe('status bar sections for an Antigravity reading', () => {
  const gemini = {
    'gemini-5h': { remaining_fraction: 0.61, reset_time: '2026-11-28T12:00:00Z' },
    'gemini-weekly': { remaining_fraction: 0.46, reset_time: '2026-12-01T00:00:00Z' },
    '3p-5h': { remaining_fraction: 0.05, reset_time: '2026-11-28T12:00:00Z' }
  }

  it('shows one bare percentage in Compact, from the most-used Gemini window', () => {
    const sections = getStatusBarUsageSections(reading(gemini), 'compact')
    expect(sections.map((section) => [section.label, section.window.usedPercent])).toEqual([
      ['', 54]
    ])
  })

  it('shows the two Gemini windows in Detailed, as plain windows rather than named pools', () => {
    const sections = getStatusBarUsageSections(reading(gemini), 'verbose')
    expect(sections.map((section) => section.window.usedPercent)).toEqual([39, 54])
    expect(sections.every((section) => !section.labelFirst)).toBe(true)
  })

  it('falls back to the third-party windows when Gemini reports none', () => {
    const sections = getStatusBarUsageSections(reading({ '3p-5h': gemini['3p-5h'] }), 'compact')
    expect(sections.map((section) => section.window.usedPercent)).toEqual([95])
  })
})
