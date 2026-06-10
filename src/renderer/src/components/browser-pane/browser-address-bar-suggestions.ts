import {
  buildSearchUrl,
  DEFAULT_SEARCH_ENGINE,
  looksLikeSearchQuery,
  normalizeBrowserNavigationUrl,
  SEARCH_ENGINE_LABELS,
  type SearchEngine
} from '../../../../shared/browser-url'
import type { BrowserHistoryEntry } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export const MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS = 8

export type BrowserAddressBarSuggestion = {
  url: string
  title: string
  subtitle: string
  lastVisitedAt: number
  visitCount: number
  isSearch: boolean
}

function scoreBrowserAddressBarSuggestion(
  entry: { url: string; title: string; lastVisitedAt: number; visitCount: number },
  query: string
): number {
  const lowerQuery = query.toLowerCase()
  const lowerUrl = entry.url.toLowerCase()
  const lowerTitle = entry.title.toLowerCase()

  if (!lowerUrl.includes(lowerQuery) && !lowerTitle.includes(lowerQuery)) {
    return -1
  }

  let score = 0
  if (lowerUrl.startsWith(lowerQuery) || lowerUrl.startsWith(`https://${lowerQuery}`)) {
    score += 100
  }
  score += Math.min(entry.visitCount, 50)
  const ageHours = (Date.now() - entry.lastVisitedAt) / (1000 * 60 * 60)
  score += Math.max(0, 24 - ageHours)
  return score
}

export function buildBrowserAddressBarSuggestions({
  browserUrlHistory,
  kagiSessionLink,
  searchEngine = DEFAULT_SEARCH_ENGINE,
  value
}: {
  browserUrlHistory: readonly BrowserHistoryEntry[]
  kagiSessionLink?: string | null
  searchEngine?: SearchEngine
  value: string
}): BrowserAddressBarSuggestion[] {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'about:blank' || trimmed.startsWith('data:')) {
    if (browserUrlHistory.length === 0) {
      return []
    }
    return [...browserUrlHistory]
      .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
      .slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
      .map((entry) => ({ ...entry, subtitle: entry.url, isSearch: false }))
  }

  const historySuggestions: BrowserAddressBarSuggestion[] =
    browserUrlHistory.length > 0
      ? browserUrlHistory
          .map((entry) => ({
            entry,
            score: scoreBrowserAddressBarSuggestion(entry, trimmed)
          }))
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS - 1)
          .map((item) => ({ ...item.entry, subtitle: item.entry.url, isSearch: false }))
      : []

  const isQuery = looksLikeSearchQuery(trimmed)
  let topAction: BrowserAddressBarSuggestion | null
  if (isQuery) {
    topAction = {
      url: buildSearchUrl(trimmed, searchEngine, { kagiSessionLink }),
      title: trimmed,
      subtitle: translate("auto.components.browser.pane.browser.address.bar.suggestions.87fcdd0da9", "{{value0}} Search", { value0: SEARCH_ENGINE_LABELS[searchEngine] }),
      lastVisitedAt: 0,
      visitCount: 0,
      isSearch: true
    }
  } else {
    const normalizedUrl = normalizeBrowserNavigationUrl(trimmed, searchEngine, {
      kagiSessionLink
    })
    // Why: rejected schemes must use the submit path's validation error;
    // a synthetic row would pass the raw string straight to webview.src.
    topAction = normalizedUrl
      ? {
          url: normalizedUrl,
          title: trimmed,
          subtitle: '',
          lastVisitedAt: 0,
          visitCount: 0,
          isSearch: false
        }
      : null
  }

  if (!topAction) {
    return historySuggestions.slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
  }

  // Why: the history row gives Enter the same target while showing real page metadata.
  const duplicateIdx = historySuggestions.findIndex((h) => h.url === topAction.url)
  if (duplicateIdx >= 0) {
    return historySuggestions.slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
  }

  return [topAction, ...historySuggestions].slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
}
