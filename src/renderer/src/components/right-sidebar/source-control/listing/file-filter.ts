import { isClipboardTextByteLengthOverLimit } from '../../../../../../shared/clipboard-text'

export const SOURCE_CONTROL_FILE_FILTER_QUERY_MAX_BYTES = 2 * 1024

export type SourceControlFileFilterState = {
  normalizedFilter: string
  tooLarge: boolean
  includesEntry?: (entry: SourceControlPathEntry) => boolean
}

export type SourceControlPathEntry = {
  path: string
}

export type SourceControlGroupedPathEntries<T extends SourceControlPathEntry> = {
  staged: T[]
  unstaged: T[]
  untracked: T[]
}

export function isSourceControlFileFilterQueryTooLarge(
  query: string,
  maxBytes = SOURCE_CONTROL_FILE_FILTER_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

/** Combines the bounded text query with optional presentation-only extension and group filters. */
export function getSourceControlFileFilterState(
  query: string,
  includesEntry?: SourceControlFileFilterState['includesEntry']
): SourceControlFileFilterState {
  if (isSourceControlFileFilterQueryTooLarge(query)) {
    return { normalizedFilter: '', tooLarge: true }
  }
  return {
    normalizedFilter: query.trim().toLowerCase(),
    tooLarge: false,
    ...(includesEntry ? { includesEntry } : {})
  }
}

/** Filters the display projection without mutating the entries used by stage, commit, or discard. */
export function filterSourceControlPathEntries<T extends SourceControlPathEntry>(
  entries: T[],
  filter: SourceControlFileFilterState
): T[] {
  if (filter.tooLarge) {
    return []
  }
  if (!filter.normalizedFilter && !filter.includesEntry) {
    return entries
  }
  return entries.filter(
    (entry) =>
      entry.path.toLowerCase().includes(filter.normalizedFilter) &&
      (!filter.includesEntry || filter.includesEntry(entry))
  )
}

/** Preserves the original groups when no filter is active, keeping bulk actions independent. */
export function filterSourceControlGroupedPathEntries<T extends SourceControlPathEntry>(
  grouped: SourceControlGroupedPathEntries<T>,
  filter: SourceControlFileFilterState
): SourceControlGroupedPathEntries<T> {
  if (filter.tooLarge) {
    return { staged: [], unstaged: [], untracked: [] }
  }
  if (!filter.normalizedFilter && !filter.includesEntry) {
    return grouped
  }
  return {
    staged: filterSourceControlPathEntries(grouped.staged, filter),
    unstaged: filterSourceControlPathEntries(grouped.unstaged, filter),
    untracked: filterSourceControlPathEntries(grouped.untracked, filter)
  }
}
