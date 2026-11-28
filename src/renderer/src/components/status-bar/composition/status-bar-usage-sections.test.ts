import { describe, expect, it } from 'vitest'
import { readAntigravityStatusLineQuota } from '../../../../../shared/agent-usage/rate-limits/antigravity-statusline-quota'
import { isUsageUrgent } from '../usage/StatusBarProviderSegment'
import { getCompactRowHeadline } from '../usage/usage-headline-sections'
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

  it('summarizes the compact menu row with the window the bar shows, yet counts every pool as urgent', () => {
    const nearlySpent = { ...gemini, '3p-5h': { ...gemini['3p-5h'], remaining_fraction: 0.05 } }
    const stored = reading(nearlySpent)
    const bar = getStatusBarUsageSections(stored, 'compact')
    const menu = getCompactRowHeadline(stored)
    expect(menu?.window.usedPercent).toBe(54)
    expect(menu?.window).toBe(bar[0].window)
    // The Claude · GPT pool at 95% is not drawn, but it still protects the chip from collapsing.
    expect(isUsageUrgent(stored)).toBe(true)
    expect(isUsageUrgent(reading({ 'gemini-5h': gemini['gemini-5h'] }))).toBe(false)
  })
})
