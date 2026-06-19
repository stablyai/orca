import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

export type SettingsSearchEntry = {
  title: string
  description?: string
  keywords?: string[]
  cmdJKeywords?: string[]
  targetSectionId?: string
}

export const SETTINGS_SEARCH_QUERY_MAX_BYTES = 2 * 1024

export function isSettingsSearchQueryTooLarge(
  query: string,
  maxBytes = SETTINGS_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function normalizeSettingsSearchQuery(query: string): string {
  return query.trim().toLowerCase()
}

export function matchesSettingsSearch(
  query: string,
  entries: SettingsSearchEntry | SettingsSearchEntry[]
): boolean {
  if (isSettingsSearchQueryTooLarge(query)) {
    return false
  }
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    return true
  }
  const normalizedQuery = trimmedQuery.toLowerCase()

  const values = Array.isArray(entries) ? entries : [entries]
  return values.some((entry) => {
    const haystack = [entry.title, entry.description ?? '', ...(entry.keywords ?? [])]
    return haystack.some((value) => value.toLowerCase().includes(normalizedQuery))
  })
}
