import type { BrowserHistoryEntry, WorkspaceSessionState } from './types'
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
  for (const entry of entries) {
    const safeUrl = redactKagiSessionToken(entry.url)
    const key = normalizeBrowserHistoryUrl(safeUrl)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    normalizedEntries.push({ ...entry, url: safeUrl, normalizedUrl: key })
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
