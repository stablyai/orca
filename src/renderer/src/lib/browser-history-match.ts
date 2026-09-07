// Tiered matching over `state.browserUrlHistory`, shared by the browser address
// bar and the new-tab omnibox. Pure: no store, no React.

import type { BrowserHistoryEntry } from '../../../shared/browser-workspace-types'
import { formatBrowserPaletteUrl } from './browser-palette-search'

/** Compared before frecency, so "the site you meant" always beats "appears somewhere". */
export type BrowserHistoryMatchTier = 'host-prefix' | 'host-substring' | 'title' | 'url-tail'

const TIER_RANK: Record<BrowserHistoryMatchTier, number> = {
  'host-prefix': 0,
  'host-substring': 1,
  title: 2,
  'url-tail': 3
}

const MAX_VISIT_COUNT_BONUS = 50
const RECENCY_BONUS_HOURS = 24

export type PreparedBrowserHistoryEntry = {
  entry: BrowserHistoryEntry
  lowerUrl: string
  lowerTitle: string
  /** Host with scheme and a leading "www." stripped, lowercased. */
  lowerHost: string
  /** visitCount contribution, fixed at prepare time. */
  frecencyBase: number
}

export type BrowserHistoryMatch = {
  entry: BrowserHistoryEntry
  tier: BrowserHistoryMatchTier
  score: number
}

const NO_MATCHES: readonly BrowserHistoryMatch[] = []
const preparedHistoryCache = new WeakMap<
  readonly BrowserHistoryEntry[],
  readonly PreparedBrowserHistoryEntry[]
>()

function historyHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Detail text for a history row: host, path, query and fragment, no scheme or "www.". */
export function formatBrowserHistoryUrl(url: string): string {
  return formatBrowserPaletteUrl(url).replace(/^www\./, '')
}

// Why prepare: the naive scorer lowercases every url and title on every
// keystroke. Hoisting it to once-per-open mirrors what the palette engines do.
export function prepareBrowserHistoryEntries(
  entries: readonly BrowserHistoryEntry[]
): readonly PreparedBrowserHistoryEntry[] {
  const cached = preparedHistoryCache.get(entries)
  if (cached) {
    return cached
  }
  const prepared = entries.map((entry) => ({
    entry,
    lowerUrl: entry.url.toLowerCase(),
    lowerTitle: entry.title.toLowerCase(),
    lowerHost: historyHost(entry.url),
    frecencyBase: Math.min(entry.visitCount, MAX_VISIT_COUNT_BONUS)
  }))
  preparedHistoryCache.set(entries, prepared)
  return prepared
}

function matchTier(
  prepared: PreparedBrowserHistoryEntry,
  lowerQuery: string
): BrowserHistoryMatchTier | null {
  // A workspace-doc entry's url is a filesystem path, so it has no host: a path
  // prefix is as deliberate as a host prefix and earns the same top tier.
  const prefixTarget = prepared.lowerHost === '' ? prepared.lowerUrl : prepared.lowerHost
  // Preserve the address-bar's long-standing behavior for fully-qualified
  // input (e.g. `https://github.com`), while still ranking bare hosts by host.
  if (prefixTarget.startsWith(lowerQuery) || prepared.lowerUrl.startsWith(lowerQuery)) {
    return 'host-prefix'
  }
  if (prepared.lowerHost.includes(lowerQuery)) {
    return 'host-substring'
  }
  if (prepared.lowerTitle.includes(lowerQuery)) {
    return 'title'
  }
  return prepared.lowerUrl.includes(lowerQuery) ? 'url-tail' : null
}

export function matchBrowserHistory({
  includeUrlTail = true,
  limit,
  now = Date.now(),
  prepared,
  query
}: {
  /** The omnibox drops path/query-only matches; the address bar keeps them, sorted last. */
  includeUrlTail?: boolean
  limit: number
  now?: number
  prepared: readonly PreparedBrowserHistoryEntry[]
  query: string
}): readonly BrowserHistoryMatch[] {
  const lowerQuery = query.trim().toLowerCase()
  if (lowerQuery === '' || limit <= 0 || prepared.length === 0) {
    return NO_MATCHES
  }
  const matches: BrowserHistoryMatch[] = []
  for (const candidate of prepared) {
    const tier = matchTier(candidate, lowerQuery)
    if (tier === null || (tier === 'url-tail' && !includeUrlTail)) {
      continue
    }
    const ageHours = (now - candidate.entry.lastVisitedAt) / (1000 * 60 * 60)
    matches.push({
      entry: candidate.entry,
      tier,
      // Clamped both ends: a future lastVisitedAt must not buy more than a fresh visit.
      score:
        candidate.frecencyBase +
        Math.min(RECENCY_BONUS_HOURS, Math.max(0, RECENCY_BONUS_HOURS - ageHours))
    })
  }
  if (matches.length === 0) {
    return NO_MATCHES
  }
  // Why the url last: ordering must not wobble between renders when a snapshot
  // reorders two entries that also tie on tier, score and recency.
  matches.sort(
    (a, b) =>
      TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
      b.score - a.score ||
      b.entry.lastVisitedAt - a.entry.lastVisitedAt ||
      a.entry.normalizedUrl.localeCompare(b.entry.normalizedUrl)
  )
  return matches.slice(0, limit)
}
