import { describe, expect, it } from 'vitest'
import { formatContextTokenCount, summarizeContextUsage } from './native-chat-context-usage-summary'

describe('summarizeContextUsage', () => {
  it('lists every non-empty CLI category, deferred ones included, largest first', () => {
    const summary = summarizeContextUsage({
      usedTokens: 29_400,
      windowTokens: 200_000,
      percentage: 15,
      estimated: false,
      categories: [
        { name: 'Messages', tokens: 10_200 },
        { name: 'System tools (deferred)', tokens: 17_600, deferred: true },
        { name: 'Skills', tokens: 0 },
        { name: 'Free space', tokens: 170_600 },
        { name: 'System prompt', tokens: 3_800 }
      ]
    })
    expect(summary.rows).toEqual([
      { name: 'Free space', tokens: 170_600, percentage: 85.3 },
      { name: 'System tools (deferred)', tokens: 17_600, percentage: 8.8 },
      { name: 'Messages', tokens: 10_200, percentage: 5.1 },
      { name: 'System prompt', tokens: 3_800, percentage: 1.9 }
    ])
    expect(summary.estimated).toBe(false)
  })
})

describe('formatContextTokenCount', () => {
  it('keeps k for thousands and writes millions with a capital M', () => {
    expect(formatContextTokenCount(10)).toBe('10')
    expect(formatContextTokenCount(18_600)).toBe('18.6k')
    expect(formatContextTokenCount(200_000)).toBe('200k')
    expect(formatContextTokenCount(981_400)).toBe('981.4k')
    expect(formatContextTokenCount(999_960)).toBe('1M')
    expect(formatContextTokenCount(1_000_000)).toBe('1M')
    expect(formatContextTokenCount(1_500_000)).toBe('1.5M')
    expect(formatContextTokenCount(-5)).toBe('0')
  })
})
