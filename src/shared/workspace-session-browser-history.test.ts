import { describe, expect, it } from 'vitest'
import {
  MAX_BROWSER_HISTORY_ENTRIES,
  normalizeBrowserHistoryEntries
} from './workspace-session-browser-history'

describe('normalizeBrowserHistoryEntries', () => {
  it('keeps the most recently visited entries when oversized history is not pre-sorted', () => {
    const history = Array.from({ length: 500 }, (_, index) => ({
      url: `https://example.com/${index}`,
      normalizedUrl: `https://example.com/${index}`,
      title: `Example ${index}`,
      lastVisitedAt: index,
      visitCount: 1
    }))

    const normalized = normalizeBrowserHistoryEntries(history)

    expect(normalized).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES)
    expect(normalized[0]?.url).toBe('https://example.com/499')
    expect(normalized.at(-1)?.url).toBe('https://example.com/300')
  })
})
