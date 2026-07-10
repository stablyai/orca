import { describe, expect, it } from 'vitest'
import type { BrowserHistoryEntry } from '../../../../shared/types'
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
