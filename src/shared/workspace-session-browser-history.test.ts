import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import {
  MAX_BROWSER_HISTORY_ENTRIES,
  normalizeBrowserHistoryEntries,
  pruneWorkspaceSessionBrowserHistory
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
  it('stops reading URLs once enough unique recent entries have been retained', () => {
    let reads = 0
    const history = Array.from({ length: 10_000 }, (_, index) => ({
      get url() {
        reads++
        return `https://example.com/${index}`
      },
      normalizedUrl: `https://example.com/${index}`,
      title: `Example ${index}`,
      lastVisitedAt: index,
      visitCount: 1
    }))
    const normalized = normalizeBrowserHistoryEntries(history)
    expect(reads).toBeLessThanOrEqual(400)
    expect(normalized).toHaveLength(200)
    expect(normalized[0]).toBe(history[9999])
    expect(normalized[199]).toBe(history[9800])
  })

  it('preserves the session on repeated normalization while still repairing and deduplicating history', () => {
    const entry = {
      url: 'https://example.com/page',
      normalizedUrl: 'https://example.com/page',
      title: 'Page',
      lastVisitedAt: 1,
      visitCount: 1
    }
    const session = { ...getDefaultWorkspaceSession(), browserUrlHistory: [entry] }
    for (let i = 0; i < 100; i++) {
      expect(pruneWorkspaceSessionBrowserHistory(session)).toBe(session)
    }
    const repaired = normalizeBrowserHistoryEntries([
      { ...entry, normalizedUrl: 'incorrect', lastVisitedAt: 3 },
      { ...entry, lastVisitedAt: 2 }
    ])
    expect(repaired).toEqual([{ ...entry, lastVisitedAt: 3 }])
    expect(
      normalizeBrowserHistoryEntries([{ ...entry, url: 'https://EXAMPLE.com/page' }])[0]
        .normalizedUrl
    ).toBe(entry.normalizedUrl)
  })
})
