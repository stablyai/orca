import type { BrowserHistoryEntry } from './browser-workspace-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { redactKagiSessionToken } from './browser-url'

export const MAX_BROWSER_HISTORY_ENTRIES = 200

export function normalizeBrowserHistoryUrl(url: string): string {
  try {
    const parsed = new URL(redactKagiSessionToken(url))
    parsed.hostname = parsed.hostname.toLowerCase()
    parsed.protocol = parsed.protocol.toLowerCase()
    let normalized = parsed.toString()
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1)
    }
    return normalized
  } catch {
    return redactKagiSessionToken(url).toLowerCase()
  }
}

export function normalizeBrowserHistoryEntries(
  entries: readonly BrowserHistoryEntry[]
): BrowserHistoryEntry[] {
  const seen = new Set<string>()
  const normalizedEntries: BrowserHistoryEntry[] = []
  // Persisted history may be unordered; normalize only until the retained cap is filled.
  const candidates = [...entries].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)

  for (const entry of candidates) {
    const safeUrl = redactKagiSessionToken(entry.url)
    const key = normalizeBrowserHistoryUrl(safeUrl)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    normalizedEntries.push(
      entry.url === safeUrl && entry.normalizedUrl === key
        ? entry
        : { ...entry, url: safeUrl, normalizedUrl: key }
    )
    if (normalizedEntries.length >= MAX_BROWSER_HISTORY_ENTRIES) {
      break
    }
  }
  return normalizedEntries
}

export function pruneWorkspaceSessionBrowserHistory(
  session: WorkspaceSessionState
): WorkspaceSessionState {
  if (!session.browserUrlHistory) {
    return session
  }
  const browserUrlHistory = normalizeBrowserHistoryEntries(session.browserUrlHistory)
  if (
    browserUrlHistory.length === session.browserUrlHistory.length &&
    browserUrlHistory.every((entry, index) => entry === session.browserUrlHistory?.[index])
  ) {
    return session
  }
  return { ...session, browserUrlHistory }
}
