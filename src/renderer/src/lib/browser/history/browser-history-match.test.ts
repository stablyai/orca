import { describe, expect, it } from 'vitest'
import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import {
  matchBrowserHistory,
  prepareBrowserHistoryEntries,
  rankBrowserTopSites,
  type BrowserHistoryMatchTier
} from './browser-history-match'

const NOW = Date.UTC(2026, 7, 27, 12)
const HOUR = 60 * 60 * 1000

function entry(overrides: Partial<BrowserHistoryEntry> & { url: string }): BrowserHistoryEntry {
  return {
    normalizedUrl: overrides.url.replace(/\/$/, ''),
    title: '',
    lastVisitedAt: NOW,
    visitCount: 1,
    ...overrides
  }
}

function match(
  entries: readonly BrowserHistoryEntry[],
  query: string,
  options: { includeUrlTail?: boolean; limit?: number } = {}
): { tier: BrowserHistoryMatchTier; url: string }[] {
  return matchBrowserHistory({
    prepared: prepareBrowserHistoryEntries(entries),
    query,
    limit: options.limit ?? 10,
    now: NOW,
    ...(options.includeUrlTail === undefined ? {} : { includeUrlTail: options.includeUrlTail })
  }).map((result) => ({ tier: result.tier, url: result.entry.url }))
}

const GIT_CORPUS = [
  entry({ url: 'https://example.com/?ref=git', title: 'Example', visitCount: 50 }),
  entry({ url: 'https://example.org/hooks', title: 'Configure git hooks', visitCount: 50 }),
  entry({ url: 'https://docs.legit.dev/api', title: 'API', visitCount: 50 }),
  entry({ url: 'https://github.com/acme/orca', title: 'acme/orca', visitCount: 50 })
]

describe('browser history match', () => {
  it('orders host-prefix above host-substring above title above url-tail', () => {
    expect(match(GIT_CORPUS, 'git')).toEqual([
      { tier: 'host-prefix', url: 'https://github.com/acme/orca' },
      { tier: 'host-substring', url: 'https://docs.legit.dev/api' },
      { tier: 'title', url: 'https://example.org/hooks' },
      { tier: 'url-tail', url: 'https://example.com/?ref=git' }
    ])
  })
})

describe('rankBrowserTopSites', () => {
  it('ranks pages by visits and recency, leaving out dev servers and non-web pages', () => {
    const ranked = rankBrowserTopSites({
      prepared: prepareBrowserHistoryEntries([
        entry({ url: 'https://react.dev/', visitCount: 3, lastVisitedAt: NOW - 48 * HOUR }),
        entry({ url: 'https://github.com/acme/orca', visitCount: 2, lastVisitedAt: NOW }),
        entry({ url: 'http://localhost:5173/', visitCount: 40 }),
        entry({ url: 'http://web.orca.localhost:3000/', visitCount: 40 }),
        entry({ url: 'file:///tmp/notes.html', visitCount: 40 }),
        entry({ url: 'https://example.com/', visitCount: 1, lastVisitedAt: NOW - 48 * HOUR })
      ]),
      limit: 2,
      now: NOW
    })

    expect(ranked.map((page) => page.url)).toEqual([
      'https://github.com/acme/orca',
      'https://react.dev/'
    ])
  })
})
