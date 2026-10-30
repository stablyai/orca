import type { BrowserHistoryEntry } from '../../../shared/browser-workspace-types'
import {
  LOOPBACK_LOCALHOST_HOSTS,
  normalizeLocalhostHostname
} from '../../../shared/localhost-worktree-labels'
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
  lowerHost: string
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

export function historyHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function formatBrowserHistoryUrl(url: string): string {
  return formatBrowserPaletteUrl(url).replace(/^www\./, '')
}

// Prepare lowercased URL/title once per open instead of rescanning them on every keystroke.
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

function frecencyScore(prepared: PreparedBrowserHistoryEntry, now: number): number {
  const ageHours = (now - prepared.entry.lastVisitedAt) / (1000 * 60 * 60)
  // Clamped both ends: a future lastVisitedAt must not buy more than a fresh visit.
  return (
    prepared.frecencyBase +
    Math.min(RECENCY_BONUS_HOURS, Math.max(0, RECENCY_BONUS_HOURS - ageHours))
  )
}

function matchTier(
  prepared: PreparedBrowserHistoryEntry,
  lowerQuery: string
): BrowserHistoryMatchTier | null {
  // Workspace-doc URLs are filesystem paths; their deliberate path prefixes deserve the host-prefix tier.
  const prefixTarget = prepared.lowerHost === '' ? prepared.lowerUrl : prepared.lowerHost
  // Preserve full-URL matching while ranking bare hosts by host.
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
    matches.push({ entry: candidate.entry, tier, score: frecencyScore(candidate, now) })
  }
  if (matches.length === 0) {
    return NO_MATCHES
  }
  // Break ties by URL so reordered snapshots cannot wobble otherwise-equal results.
  matches.sort(
    (a, b) =>
      TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
      b.score - a.score ||
      b.entry.lastVisitedAt - a.entry.lastVisitedAt ||
      a.entry.normalizedUrl.localeCompare(b.entry.normalizedUrl)
  )
  return matches.slice(0, limit)
}

// Why loopback is out: dev servers come and go, so the new-tab page lists the live ones instead.
function isTopSiteCandidate(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false
    }
    const hostname = normalizeLocalhostHostname(parsed.hostname)
    return !LOOPBACK_LOCALHOST_HOSTS.has(hostname) && !hostname.endsWith('.localhost')
  } catch {
    return false
  }
}

/** New-tab tiles, one per page as Chrome does, so removing a tile removes exactly that page. */
export function rankBrowserTopSites({
  limit,
  now = Date.now(),
  prepared
}: {
  limit: number
  now?: number
  prepared: readonly PreparedBrowserHistoryEntry[]
}): readonly BrowserHistoryEntry[] {
  return prepared
    .filter((candidate) => isTopSiteCandidate(candidate.entry.url))
    .map((candidate) => ({ entry: candidate.entry, score: frecencyScore(candidate, now) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.lastVisitedAt - a.entry.lastVisitedAt ||
        a.entry.normalizedUrl.localeCompare(b.entry.normalizedUrl)
    )
    .slice(0, limit)
    .map((ranked) => ranked.entry)
}
