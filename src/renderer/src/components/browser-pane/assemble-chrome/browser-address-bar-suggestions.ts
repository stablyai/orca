import {
  buildSearchUrl,
  DEFAULT_SEARCH_ENGINE,
  looksLikeSearchQuery,
  normalizeBrowserNavigationUrl,
  SEARCH_ENGINE_LABELS,
  type SearchEngine
} from '../../../../../shared/browser-url'
import type {
  BrowserHistoryEntry,
  BrowserPageDocLocation
} from '../../../../../shared/browser-workspace-types'
import type { WorkspaceDocHistoryEntry } from '../../../../../shared/workspace-doc-history'
import { matchBrowserHistory, prepareBrowserHistoryEntries } from '@/lib/browser-history-match'
import { isClipboardTextByteLengthOverLimit } from '../../../../../shared/clipboard-text'
import { translate } from '@/i18n/i18n'

export const MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS = 8
export const BROWSER_ADDRESS_BAR_QUERY_MAX_BYTES = 2 * 1024

export type BrowserAddressBarSuggestion = {
  /** For a workspace-doc row this is the document's absolute path — a selection identity that even
   *  the url fallback routes correctly, since every pane's navigate runs path detection first. */
  url: string
  title: string
  subtitle: string
  lastVisitedAt: number
  visitCount: number
  isSearch: boolean
  /** Set on a previewed-document row; selecting it opens the document on a fresh grant. */
  docLocation?: BrowserPageDocLocation
}

function toWorkspaceDocSuggestion(entry: WorkspaceDocHistoryEntry): BrowserAddressBarSuggestion {
  return {
    url: entry.docLocation.filePath,
    title: entry.title,
    subtitle: entry.docLocation.filePath,
    lastVisitedAt: entry.lastVisitedAt,
    visitCount: entry.visitCount,
    isSearch: false,
    docLocation: entry.docLocation
  }
}

export function isBrowserAddressBarQueryTooLarge(
  query: string,
  maxBytes = BROWSER_ADDRESS_BAR_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function buildBrowserAddressBarSuggestions({
  browserUrlHistory,
  workspaceDocHistory = [],
  kagiSessionLink,
  searchEngine = DEFAULT_SEARCH_ENGINE,
  value
}: {
  browserUrlHistory: readonly BrowserHistoryEntry[]
  workspaceDocHistory?: readonly WorkspaceDocHistoryEntry[]
  kagiSessionLink?: string | null
  searchEngine?: SearchEngine
  value: string
}): BrowserAddressBarSuggestion[] {
  if (isBrowserAddressBarQueryTooLarge(value)) {
    return []
  }
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'about:blank' || trimmed.startsWith('data:')) {
    const recents: BrowserAddressBarSuggestion[] = [
      ...browserUrlHistory.map((entry) => ({ ...entry, subtitle: entry.url, isSearch: false })),
      ...workspaceDocHistory.map(toWorkspaceDocSuggestion)
    ]
    return recents
      .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
      .slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
  }
  const documentRows = workspaceDocHistory.map(toWorkspaceDocSuggestion)
  const documentEntries: BrowserHistoryEntry[] = documentRows.map((row) => ({
    url: row.url,
    normalizedUrl: row.url,
    title: row.title,
    lastVisitedAt: row.lastVisitedAt,
    visitCount: row.visitCount
  }))
  const rowByEntry = new Map<BrowserHistoryEntry, BrowserAddressBarSuggestion>()
  for (const entry of browserUrlHistory) {
    rowByEntry.set(entry, { ...entry, subtitle: entry.url, isSearch: false })
  }
  documentEntries.forEach((entry, index) => rowByEntry.set(entry, documentRows[index]))
  // Why prepare the caller's array as-is: it is the stable `browserUrlHistory`
  // identity, so the prepare cache hits instead of re-lowercasing every keystroke.
  const preparedHistory = prepareBrowserHistoryEntries(browserUrlHistory)
  const prepared =
    documentEntries.length === 0
      ? preparedHistory
      : [...preparedHistory, ...prepareBrowserHistoryEntries(documentEntries)]
  // Why url-tail is kept here: the address bar is a navigation surface, so a
  // path-only recall is still a destination — it just never outranks a real one.
  const historySuggestions: BrowserAddressBarSuggestion[] = matchBrowserHistory({
    prepared,
    query: trimmed,
    limit: MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS - 1
  })
    .map(({ entry }) => rowByEntry.get(entry))
    .filter((row): row is BrowserAddressBarSuggestion => row !== undefined)

  const isQuery = looksLikeSearchQuery(trimmed)
  let topAction: BrowserAddressBarSuggestion | null
  if (isQuery) {
    topAction = {
      url: buildSearchUrl(trimmed, searchEngine, { kagiSessionLink }),
      title: trimmed,
      subtitle: translate(
        'auto.components.browser.pane.browser.address.bar.suggestions.87fcdd0da9',
        '{{value0}} Search',
        { value0: SEARCH_ENGINE_LABELS[searchEngine] }
      ),
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
  if (duplicateIdx !== -1) {
    return historySuggestions.slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
  }

  return [topAction, ...historySuggestions].slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
}
