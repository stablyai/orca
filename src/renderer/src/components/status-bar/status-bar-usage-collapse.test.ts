import { describe, expect, it } from 'vitest'
import { pickCollapsedUsageChips } from './status-bar-usage-collapse'

const GAP = 12
const MORE = 20
// Roster order, as the status bar renders it.
const chips = [
  { provider: 'claude', width: 60, urgent: false },
  { provider: 'codex', width: 60, urgent: false },
  { provider: 'gemini', width: 60, urgent: false },
  { provider: 'grok', width: 60, urgent: false },
  { provider: 'cursor', width: 60, urgent: true }
]

describe('pickCollapsedUsageChips', () => {
  it('collapses nothing when the row fits', () => {
    expect(pickCollapsedUsageChips(chips, 0, MORE, GAP)).toEqual([])
    expect(pickCollapsedUsageChips(chips, -40, MORE, GAP)).toEqual([])
  })

  it('drops calm agents from the end of the roster and keeps the urgent one', () => {
    // 10px over: one chip frees 72px, which also pays for the "+N" chip (20 + 12).
    expect(pickCollapsedUsageChips(chips, 10, MORE, GAP)).toEqual(['grok'])
    expect(pickCollapsedUsageChips(chips, 60, MORE, GAP)).toEqual(['grok', 'gemini'])
  })

  it('reserves room for the "+N" chip it introduces', () => {
    // 41px over + 32px for "+N" = 73px, one more than a single chip frees.
    expect(pickCollapsedUsageChips(chips, 41, MORE, GAP)).toEqual(['grok', 'gemini'])
  })

  it('drops urgent agents only after every calm one', () => {
    expect(pickCollapsedUsageChips(chips, 300, MORE, GAP)).toEqual([
      'grok',
      'gemini',
      'codex',
      'claude',
      'cursor'
    ])
  })

  it('drops urgent agents from the end of the roster too', () => {
    const allUrgent = chips.map((chip) => ({ ...chip, urgent: true }))
    expect(pickCollapsedUsageChips(allUrgent, 10, MORE, GAP)).toEqual(['cursor'])
  })
})
