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
  /** Workspace documents use absolute paths as selection identities; navigation fallbacks run path detection first. */
  url: string
  title: string
  subtitle: string
  lastVisitedAt: number
  visitCount: number
  isSearch: boolean
  faviconUrl?: string | null
  /** Set on a visited-page row: the history entry it came from, so the row can be removed. */
  normalizedUrl?: string
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

function toBrowserHistorySuggestion(entry: BrowserHistoryEntry): BrowserAddressBarSuggestion {
  return { ...entry, subtitle: entry.url, isSearch: false }
}

/** Every visited page and previewed document as rows, newest first. */
export function listBrowserHistoryRecents(
  browserUrlHistory: readonly BrowserHistoryEntry[],
  workspaceDocHistory: readonly WorkspaceDocHistoryEntry[]
): BrowserAddressBarSuggestion[] {
  return [
    ...browserUrlHistory.map(toBrowserHistorySuggestion),
    ...workspaceDocHistory.map(toWorkspaceDocSuggestion)
  ].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
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
  /** true allows inline completion; a string pins row zero to the visible completion despite history changes. */
  inline?: true | string | null
}

export function buildBrowserAddressBarSuggestions(
  args: BrowserAddressBarSuggestionInput
): BrowserAddressBarSuggestion[] {
  return withSiteFavicons(buildSuggestionRows(args), args.browserUrlHistory)
}

// Typed addresses/host completions have no history row; reuse the site’s favicon.
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
    return listBrowserHistoryRecents(browserUrlHistory, workspaceDocHistory).slice(
      0,
      MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS
    )
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
    rowByEntry.set(entry, toBrowserHistorySuggestion(entry))
  }
  documentEntries.forEach((entry, index) => rowByEntry.set(entry, documentRows[index]))
  // Prepare the stable caller array directly so keystrokes reuse the lowercase cache.
  const preparedHistory = prepareBrowserHistoryEntries(browserUrlHistory)
  const prepared =
    documentEntries.length === 0
      ? preparedHistory
      : [...preparedHistory, ...prepareBrowserHistoryEntries(documentEntries)]
  // Keep low-priority path-tail recall because every address-bar result is still navigable.
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
    // Rejected schemes must reach submit validation; synthetic rows would write raw strings directly to webview.src.
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

  // Row zero follows Enter: use a valid inline completion, otherwise the typed action.
  const completion =
    inline === true ? findInlineCompletion(value, historySuggestions) : shownCompletion(inline)
  if (completion) {
    const { text, url } = completion
    const completedRow: BrowserAddressBarSuggestion = {
      ...(historySuggestions.find((row) => row.url === url) ?? {
        lastVisitedAt: 0,
        visitCount: 0
      }),
      url,
      title: text,
      subtitle: '',
      isSearch: false,
      inlineText: text
    }
    const typedAction = topAction && topAction.url !== url ? [topAction] : []
    const rest = historySuggestions.filter((row) => row.url !== url && row.url !== topAction?.url)
    return [
      completedRow,
      ...rest.slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS - 1 - typedAction.length),
      ...typedAction
    ]
  }
  if (!topAction) {
    return historySuggestions.slice(0, MAX_BROWSER_ADDRESS_BAR_SUGGESTIONS)
  }
  // Keep the navigation action recognizable even when history has a title for this URL.
  const visited = historySuggestions.find((row) => row.url === topAction.url)
  const topRow = {
    ...(visited ?? topAction),
    title: topAction.title,
    subtitle: topAction.subtitle,
    isSearch: topAction.isSearch
  }
  return [topRow, ...historySuggestions.filter((row) => row.url !== topAction.url)].slice(
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

/** Complete only the host while typing within it, avoiding unexpected navigation to a visited deeper path. */
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
  // Accept only completions whose text submits to the intended host or visited path through normal pane validation.
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
