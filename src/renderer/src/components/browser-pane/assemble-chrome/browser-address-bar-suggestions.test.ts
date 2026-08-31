import { describe, expect, it } from 'vitest'
import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import {
  BROWSER_ADDRESS_BAR_QUERY_MAX_BYTES,
  buildBrowserAddressBarSuggestions,
  isBrowserAddressBarQueryTooLarge
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
})
