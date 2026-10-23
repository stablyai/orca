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
import {
  formatBrowserHistoryUrl,
  historyHost,
  matchBrowserHistory,
  prepareBrowserHistoryEntries
} from '@/lib/browser-history-match'
import { displayableFaviconUrl } from '../describe-page/browser-favicon-url'
import { formatBrowserPaletteUrl } from '@/lib/browser-palette-search'
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
  faviconUrl?: string | null
  /** Set on a previewed-document row; selecting it opens the document on a fresh grant. */
  docLocation?: BrowserPageDocLocation
  /** On row 0 when the bar completes the typed text inline to it: the full bar text. */
  inlineText?: string
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

type BrowserAddressBarSuggestionInput = {
  browserUrlHistory: readonly BrowserHistoryEntry[]
  workspaceDocHistory?: readonly WorkspaceDocHistoryEntry[]
  kagiSessionLink?: string | null
  searchEngine?: SearchEngine
  value: string
  /**
   * `true` on a keystroke that may complete inline; the bar text while it shows a completion, so
   * row 0 stays that page whatever history does meanwhile.
   */
  inline?: true | string | null
}

export function buildBrowserAddressBarSuggestions(
  args: BrowserAddressBarSuggestionInput
): BrowserAddressBarSuggestion[] {
  return withSiteFavicons(buildSuggestionRows(args), args.browserUrlHistory)
}

// Why by host: a typed address or a host completion has no history entry of its own, and Orca
// already treats an icon as the site's (the tab strip keeps it across same-site pages).
function withSiteFavicons(
  rows: BrowserAddressBarSuggestion[],
  browserUrlHistory: readonly BrowserHistoryEntry[]
): BrowserAddressBarSuggestion[] {
  return rows.map((row) => {
    if (row.isSearch || row.docLocation || displayableFaviconUrl(row.faviconUrl)) {
      return row
    }
    const host = historyHost(row.url)
    const faviconUrl = host
      ? prepareBrowserHistoryEntries(browserUrlHistory).find(
          ({ entry, lowerHost }) => lowerHost === host && displayableFaviconUrl(entry.faviconUrl)
        )?.entry.faviconUrl
      : null
    return faviconUrl ? { ...row, faviconUrl } : row
  })
}

function buildSuggestionRows({
  browserUrlHistory,
  workspaceDocHistory = [],
  kagiSessionLink,
  searchEngine = DEFAULT_SEARCH_ENGINE,
  value,
  inline = null
}: BrowserAddressBarSuggestionInput): BrowserAddressBarSuggestion[] {
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

  // Why: like Chrome, row 0 is what Enter does. A visited page that starts with the typed text
  // takes it (the bar completes inline to it); otherwise what you typed does.
  const completion =
    inline === true ? findInlineCompletion(value, historySuggestions) : shownCompletion(inline)
  if (completion) {
    const { text, url } = completion
    const visited = historySuggestions.find((row) => row.url === url)
    const completedRow = visited
      ? { ...visited, inlineText: text }
      : {
          url,
          title: text,
          subtitle: '',
          lastVisitedAt: 0,
          visitCount: 0,
          isSearch: false,
          inlineText: text
        }
    const rest = historySuggestions.filter((row) => row !== visited && row.url !== topAction?.url)
    return [completedRow, ...rest.slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS - 2), topAction]
      .filter((row): row is BrowserAddressBarSuggestion => row !== null)
      .slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
  }
  if (!topAction) {
    return historySuggestions.slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
  }
  // Why: the history row gives Enter the same target while showing real page metadata, so it
  // takes the typed row's place on top.
  const duplicate = historySuggestions.find((h) => h.url === topAction.url)
  return [duplicate ?? topAction, ...historySuggestions.filter((h) => h !== duplicate)].slice(
    0,
    MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS
  )
}

function findInlineCompletion(
  typed: string,
  rows: readonly BrowserAddressBarSuggestion[]
): { text: string; url: string } | null {
  for (const row of rows) {
    if (row.docLocation) {
      continue
    }
    const completion = getBrowserAddressBarInlineCompletion(typed, row.url)
    if (completion) {
      return completion
    }
  }
  return null
}

// Why the text's own URL: Enter submits the bar text, so that is where the completion goes.
function shownCompletion(text: string | null): { text: string; url: string } | null {
  const url = text ? normalizeBrowserNavigationUrl(text) : null
  return text && url ? { text, url } : null
}

/**
 * Completes `typed` inline to a visited URL, keeping what the user typed. While the typed text
 * is still inside the host it completes only the host, as Chrome does, so typing an address
 * never lands on some deeper page of that site.
 */
export function getBrowserAddressBarInlineCompletion(
  typed: string,
  url: string
): { text: string; url: string } | null {
  if (typed === '' || /\s/.test(typed)) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const schemeLength = /^[a-z][a-z\d+.-]*:\/\//i.exec(typed)?.[0].length ?? 0
  const pathStart = typed.indexOf('/', schemeLength)
  const withinHost = pathStart === -1
  // Why web only: a file URL's host (empty, or a UNC server) is never a site to complete to.
  if (withinHost && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  const origin = `${parsed.protocol}//${parsed.host}`
  const forms = withinHost
    ? [historyHost(url), parsed.host, origin]
    : [formatBrowserHistoryUrl(url), formatBrowserPaletteUrl(url), url]
  // Why case only counts from the path on: hosts are case-insensitive, paths and queries aren't.
  const prefixEnd = withinHost ? typed.length : pathStart
  const form = forms.find(
    (candidate) =>
      candidate.slice(0, prefixEnd).toLowerCase() === typed.slice(0, prefixEnd).toLowerCase() &&
      candidate.startsWith(typed.slice(prefixEnd), prefixEnd)
  )
  if (form === undefined) {
    return null
  }
  // Why: Enter submits the bar text through the pane's own checks, so the completion must go
  // exactly where that text goes: the typed site for a host, the visited page for a path.
  const text = typed + form.slice(typed.length)
  const target = normalizeBrowserNavigationUrl(text)
  if (
    !target ||
    // A single-label host like "intranet" is a search to the submit path, not an address.
    normalizeBrowserNavigationUrl(text, DEFAULT_SEARCH_ENGINE) !== target ||
    (!withinHost && target !== normalizeBrowserNavigationUrl(url)) ||
    // `localhost:3000` submits as http, so it can't stand for a visited https site (or vice versa).
    (withinHost && new URL(target).protocol !== parsed.protocol)
  ) {
    return null
  }
  return { text, url: target }
}
