import { isClipboardTextByteLengthOverLimit } from '../../../../../../shared/clipboard-text'

export const SOURCE_CONTROL_FILE_FILTER_QUERY_MAX_BYTES = 2 * 1024

export type SourceControlFileFilterState = {
  normalizedFilter: string
  tooLarge: boolean
}

export type SourceControlPathEntry = {
  path: string
}

export function isSourceControlFileFilterQueryTooLarge(
  query: string,
  maxBytes = SOURCE_CONTROL_FILE_FILTER_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function getSourceControlFileFilterState(query: string): SourceControlFileFilterState {
  if (isSourceControlFileFilterQueryTooLarge(query)) {
    return { normalizedFilter: '', tooLarge: true }
  }
  const trimmed = query.trim()
  if (!trimmed) {
    return { normalizedFilter: '', tooLarge: false }
  }
  return { normalizedFilter: trimmed.toLowerCase(), tooLarge: false }
}

export function filterSourceControlPathEntries<T extends SourceControlPathEntry>(
  entries: T[],
  filter: SourceControlFileFilterState
): T[] {
  if (filter.tooLarge) {
    return []
  }
  if (!filter.normalizedFilter) {
    return entries
  }
  return entries.filter((entry) => entry.path.toLowerCase().includes(filter.normalizedFilter))
}
