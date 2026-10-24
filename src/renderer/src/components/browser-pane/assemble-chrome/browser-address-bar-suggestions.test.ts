import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import {
  BROWSER_ADDRESS_BAR_QUERY_MAX_BYTES,
  buildBrowserAddressBarSuggestions,
  getBrowserAddressBarInlineCompletion,
  isBrowserAddressBarQueryTooLarge,
  MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS
} from './browser-address-bar-suggestions'

function historyEntry(overrides: Partial<BrowserHistoryEntry>): BrowserHistoryEntry {
  return {
    url: 'https://example.com/',
    normalizedUrl: 'https://example.com',
    title: 'Example',
    lastVisitedAt: 1_700_000_000_000,
    visitCount: 1,
    ...overrides
  }
}

describe('browser address bar suggestions', () => {
  it('keeps the most recent history suggestions for blank input', () => {
    const suggestions = buildBrowserAddressBarSuggestions({
      value: '',
      browserUrlHistory: [
        historyEntry({
          url: 'https://old.example.com/',
          normalizedUrl: 'https://old.example.com',
          title: 'Old',
          lastVisitedAt: 1
        }),
        historyEntry({
          url: 'https://new.example.com/',
          normalizedUrl: 'https://new.example.com',
          title: 'New',
          lastVisitedAt: 2
        })
      ]
    })

    expect(suggestions.map((suggestion) => suggestion.url)).toEqual([
      'https://new.example.com/',
      'https://old.example.com/'
    ])
  })

  it('puts the search action first for bare query input', () => {
    const suggestions = buildBrowserAddressBarSuggestions({
      value: 'react hooks',
      browserUrlHistory: [],
      searchEngine: 'duckduckgo'
    })

    expect(suggestions[0]).toMatchObject({
      url: 'https://duckduckgo.com/?q=react%20hooks',
      title: 'react hooks',
      subtitle: 'DuckDuckGo Search',
      isSearch: true
    })
  })

  it('puts URL-like navigation first when normalization succeeds', () => {
    const suggestions = buildBrowserAddressBarSuggestions({
      value: 'example.com',
      browserUrlHistory: []
    })

    expect(suggestions[0]).toMatchObject({
      url: 'https://example.com/',
      title: 'example.com',
      isSearch: false
    })
  })

  it('does not turn a rejected scheme into a selectable navigation row', () => {
    const suggestions = buildBrowserAddressBarSuggestions({
      value: 'javascript:alert(1)',
      browserUrlHistory: []
    })

    expect(suggestions).toEqual([])
  })

  it('rejects oversized pasted values before scoring history or building a search URL', () => {
    const oversizedValue = 'secret-browser-address'.repeat(BROWSER_ADDRESS_BAR_QUERY_MAX_BYTES)
    const throwingHistory = [
      {
        get url(): string {
          throw new Error('oversized address-bar values must not scan history urls')
        },
        get title(): string {
          throw new Error('oversized address-bar values must not scan history titles')
        },
        lastVisitedAt: 1,
        visitCount: 1,
        normalizedUrl: 'https://example.com'
      }
    ] as BrowserHistoryEntry[]

    expect(isBrowserAddressBarQueryTooLarge(oversizedValue)).toBe(true)
    expect(
      buildBrowserAddressBarSuggestions({
        value: oversizedValue,
        browserUrlHistory: throwingHistory
      })
    ).toEqual([])
  })

  it('rejects oversized whitespace before trimming', () => {
    expect(
      buildBrowserAddressBarSuggestions({
        value: ' '.repeat(BROWSER_ADDRESS_BAR_QUERY_MAX_BYTES + 1),
        browserUrlHistory: [
          {
            url: 'https://example.com',
            title: 'Example',
            lastVisitedAt: 1,
            visitCount: 1,
            normalizedUrl: 'https://example.com'
          }
        ]
      })
    ).toEqual([])
  })

  describe('history scoring', () => {
    const now = 1_700_000_000_000
    const hoursAgo = (hours: number): number => now - hours * 60 * 60 * 1000
    // The synthetic top row is composition, not scoring; ranking asserts on history only.
    const historyUrls = (suggestions: readonly { isSearch: boolean; url: string }[]): string[] =>
      suggestions.filter((suggestion) => !suggestion.isSearch).map((suggestion) => suggestion.url)

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(now)
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('ranks a host-prefix match above a host-substring match above a title match', () => {
      const suggestions = buildBrowserAddressBarSuggestions({
        value: 'git',
        browserUrlHistory: [
          historyEntry({
            url: 'https://example.com/setup',
            normalizedUrl: 'https://example.com/setup',
            title: 'Configure git hooks',
            lastVisitedAt: now,
            visitCount: 50
          }),
          historyEntry({
            url: 'https://docs.github.com/actions',
            normalizedUrl: 'https://docs.github.com/actions',
            title: 'Actions',
            lastVisitedAt: hoursAgo(20),
            visitCount: 1
          }),
          historyEntry({
            url: 'https://github.com/acme/orca',
            normalizedUrl: 'https://github.com/acme/orca',
            title: 'acme/orca',
            lastVisitedAt: hoursAgo(20),
            visitCount: 1
          })
        ]
      })

      expect(historyUrls(suggestions)).toEqual([
        'https://github.com/acme/orca',
        'https://docs.github.com/actions',
        'https://example.com/setup'
      ])
    })

    it('sorts a path-only match last even when it is frequent and fresh', () => {
      const suggestions = buildBrowserAddressBarSuggestions({
        value: 'git',
        browserUrlHistory: [
          historyEntry({
            url: 'https://example.com/?ref=git',
            normalizedUrl: 'https://example.com/?ref=git',
            title: 'Example',
            lastVisitedAt: now,
            visitCount: 500
          }),
          historyEntry({
            url: 'https://example.org/notes',
            normalizedUrl: 'https://example.org/notes',
            title: 'Stale git notes',
            lastVisitedAt: hoursAgo(400),
            visitCount: 1
          })
        ]
      })

      expect(historyUrls(suggestions)).toEqual([
        'https://example.org/notes',
        'https://example.com/?ref=git'
      ])
    })

    it('clamps the visit-count bonus at 50 so recency still breaks the tie', () => {
      const suggestions = buildBrowserAddressBarSuggestions({
        value: 'acme',
        browserUrlHistory: [
          historyEntry({
            url: 'https://acme.dev/a',
            normalizedUrl: 'https://acme.dev/a',
            title: 'A',
            lastVisitedAt: hoursAgo(23),
            visitCount: 50
          }),
          historyEntry({
            url: 'https://acme.dev/b',
            normalizedUrl: 'https://acme.dev/b',
            title: 'B',
            lastVisitedAt: hoursAgo(1),
            visitCount: 5000
          })
        ]
      })

      expect(historyUrls(suggestions)).toEqual(['https://acme.dev/b', 'https://acme.dev/a'])
    })

    it('floors the recency bonus at zero for entries older than a day', () => {
      const suggestions = buildBrowserAddressBarSuggestions({
        value: 'acme',
        browserUrlHistory: [
          historyEntry({
            url: 'https://acme.dev/ancient',
            normalizedUrl: 'https://acme.dev/ancient',
            title: 'Ancient',
            lastVisitedAt: hoursAgo(10_000),
            visitCount: 3
          }),
          historyEntry({
            url: 'https://acme.dev/old',
            normalizedUrl: 'https://acme.dev/old',
            title: 'Old',
            lastVisitedAt: hoursAgo(100),
            visitCount: 2
          })
        ]
      })

      expect(historyUrls(suggestions)).toEqual(['https://acme.dev/ancient', 'https://acme.dev/old'])
    })

    it('leaves one slot for the synthetic top row when history overflows', () => {
      const suggestions = buildBrowserAddressBarSuggestions({
        value: 'acme',
        browserUrlHistory: Array.from({ length: 20 }, (_, index) =>
          historyEntry({
            url: `https://acme.dev/page-${index}`,
            normalizedUrl: `https://acme.dev/page-${index}`,
            title: `Page ${index}`,
            lastVisitedAt: hoursAgo(index),
            visitCount: 1
          })
        )
      })

      expect(suggestions).toHaveLength(MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
      expect(suggestions[0]).toMatchObject({ isSearch: true })
      expect(suggestions.slice(1).every((suggestion) => suggestion.url.includes('/page-'))).toBe(
        true
      )
    })

    it('folds the synthetic row into the history row and keeps it on top, where Enter goes', () => {
      const suggestions = buildBrowserAddressBarSuggestions({
        value: 'acme.dev',
        browserUrlHistory: [
          historyEntry({
            url: 'https://acme.dev/docs',
            normalizedUrl: 'https://acme.dev/docs',
            title: 'Acme docs',
            lastVisitedAt: now,
            visitCount: 40
          }),
          historyEntry({
            url: 'https://acme.dev/',
            normalizedUrl: 'https://acme.dev',
            title: 'Acme',
            lastVisitedAt: now,
            visitCount: 4
          })
        ]
      })

      expect(suggestions).toEqual([
        expect.objectContaining({ url: 'https://acme.dev/', title: 'Acme', isSearch: false }),
        expect.objectContaining({ url: 'https://acme.dev/docs' })
      ])
    })

    it('puts the completed host first and the typed search last while the bar completes inline', () => {
      const suggestions = buildBrowserAddressBarSuggestions({
        value: 'git',
        inline: true,
        searchEngine: 'duckduckgo',
        browserUrlHistory: [
          historyEntry({
            url: 'https://github.com/stablyai/orca/pulls',
            normalizedUrl: 'https://github.com/stablyai/orca/pulls',
            title: 'Pull requests',
            lastVisitedAt: now,
            visitCount: 9
          }),
          historyEntry({
            url: 'https://github.com/stablyai/orca',
            normalizedUrl: 'https://github.com/stablyai/orca',
            title: 'Orca',
            lastVisitedAt: now,
            visitCount: 2
          })
        ]
      })

      expect(suggestions.map((suggestion) => suggestion.url)).toEqual([
        'https://github.com/',
        'https://github.com/stablyai/orca/pulls',
        'https://github.com/stablyai/orca',
        'https://duckduckgo.com/?q=git'
      ])
    })

    // Background tabs re-rank or evict history while the bar shows `github.com`.
    it('keeps the completion the bar shows on top whatever history does', () => {
      const suggestions = buildBrowserAddressBarSuggestions({
        value: 'git',
        inline: 'github.com',
        browserUrlHistory: [
          historyEntry({
            url: 'https://gitlab.com/',
            normalizedUrl: 'https://gitlab.com',
            title: 'GitLab',
            lastVisitedAt: now,
            visitCount: 9
          })
        ]
      })

      expect(suggestions[0]).toMatchObject({
        url: 'https://github.com/',
        inlineText: 'github.com'
      })
    })
  })
})

describe('suggestion favicons', () => {
  it("gives page rows without an icon of their own the site's icon", () => {
    const faviconUrl = 'https://www.youtube.com/s/favicon.ico'
    const history = [
      historyEntry({
        url: 'https://www.youtube.com/watch?v=1',
        normalizedUrl: 'https://www.youtube.com/watch?v=1',
        title: 'Video',
        faviconUrl
      }),
      historyEntry({
        url: 'https://www.youtube.com/feed',
        normalizedUrl: 'https://www.youtube.com/feed',
        title: 'Feed',
        faviconUrl: null
      })
    ]
    const suggestions = buildBrowserAddressBarSuggestions({
      value: 'you',
      browserUrlHistory: history,
      inline: true
    })
    // Row 0 is the host completion `youtube.com`, which has no history entry and no `www.`.
    expect(
      Object.fromEntries(
        suggestions.filter((row) => !row.isSearch).map((row) => [row.url, row.faviconUrl])
      )
    ).toEqual({
      'https://youtube.com/': faviconUrl,
      'https://www.youtube.com/watch?v=1': faviconUrl,
      'https://www.youtube.com/feed': faviconUrl
    })
  })
})

describe('getBrowserAddressBarInlineCompletion', () => {
  it.each([
    ['git', 'https://github.com/stablyai/orca', 'github.com', 'https://github.com/'],
    // A fully typed host must never complete to a deeper page of that site.
    [
      'localhost:3000',
      'http://localhost:3000/dashboard',
      'localhost:3000',
      'http://localhost:3000/'
    ],
    ['www.ex', 'https://www.example.com/a', 'www.example.com', 'https://www.example.com/'],
    ['ex', 'https://www.example.com/a', 'example.com', 'https://example.com/'],
    ['https://gi', 'https://github.com/x', 'https://github.com', 'https://github.com/'],
    [
      'GitHub.com/st',
      'https://github.com/stablyai/orca',
      'GitHub.com/stablyai/orca',
      'https://github.com/stablyai/orca'
    ]
  ])('completes %s against %s', (typed, url, text, target) => {
    expect(getBrowserAddressBarInlineCompletion(typed, url)).toEqual({ text, url: target })
  })

  it.each([
    ['orca', 'https://github.com/stablyai/orca'],
    ['git hub', 'https://github.com/'],
    ['fi', 'file:///Users/me/report.html'],
    // A UNC path's host is a file server, not a site.
    ['fil', 'file://files.example.com/share/report.html'],
    // The bare host submits with the default scheme, not the visited one.
    ['loc', 'https://localhost:3000/dashboard'],
    ['exa', 'http://example.com/'],
    // Paths are case-sensitive, so /D must not complete to (and then open) /docs.
    ['example.com/D', 'https://example.com/docs'],
    // Submit would search for a bare single-label word, so it must not look like an address.
    ['in', 'https://intranet/docs']
  ])('does not complete %s against %s', (typed, url) => {
    expect(getBrowserAddressBarInlineCompletion(typed, url)).toBeNull()
  })
})

describe('workspace document suggestions', () => {
  const DOC_ENTRY = {
    docLocation: {
      kind: 'workspace-doc' as const,
      worktreeId: 'wt-1',
      filePath: '/repo/docs/report.html'
    },
    title: 'Quarterly Report',
    lastVisitedAt: 10,
    visitCount: 3
  }

  it('merges previewed documents into the empty-query recents by recency', () => {
    const rows = buildBrowserAddressBarSuggestions({
      value: '',
      browserUrlHistory: [
        {
          url: 'https://example.com',
          title: 'Example',
          lastVisitedAt: 5,
          visitCount: 1,
          normalizedUrl: 'https://example.com'
        }
      ],
      workspaceDocHistory: [DOC_ENTRY]
    })
    expect(rows.map((row) => row.title)).toEqual(['Quarterly Report', 'Example'])
    expect(rows[0]?.docLocation).toEqual(DOC_ENTRY.docLocation)
    // The row's selection identity is the document's path, never a preview URL.
    expect(rows[0]?.url).toBe('/repo/docs/report.html')
    expect(JSON.stringify(rows)).not.toContain('orca-preview://')
  })

  it('matches typed queries against the document title and path', () => {
    const rows = buildBrowserAddressBarSuggestions({
      value: 'quarterly',
      browserUrlHistory: [],
      workspaceDocHistory: [DOC_ENTRY]
    })
    expect(rows.some((row) => row.docLocation)).toBe(true)

    const byPath = buildBrowserAddressBarSuggestions({
      value: 'docs/report',
      browserUrlHistory: [],
      workspaceDocHistory: [DOC_ENTRY]
    })
    expect(byPath.some((row) => row.docLocation)).toBe(true)
  })

  it('ranks a path-prefix document above a heavily visited url-tail history match', () => {
    const rows = buildBrowserAddressBarSuggestions({
      value: '/repo/docs',
      browserUrlHistory: [
        {
          url: 'https://example.com/repo/docs/index.html',
          normalizedUrl: 'https://example.com/repo/docs/index.html',
          title: 'Docs Index',
          lastVisitedAt: Date.now(),
          visitCount: 500
        }
      ],
      workspaceDocHistory: [DOC_ENTRY]
    })

    expect(rows.find((row) => !row.isSearch)?.docLocation).toEqual(DOC_ENTRY.docLocation)
  })
})
