import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

export type WorktreeSymlinkPathSuggestion = {
  name: string
  isDirectory: boolean
}

export type WorktreeSymlinkPathFilterState<T extends WorktreeSymlinkPathSuggestion> = {
  queryTrimmed: string
  filtered: T[]
  showLiteralItem: boolean
  isQueryTooLarge: boolean
}

export const WORKTREE_SYMLINK_PATH_QUERY_MAX_BYTES = 2 * 1024
export const WORKTREE_SYMLINK_PATH_MAX_SUGGESTIONS = 50

export function isWorktreeSymlinkPathQueryTooLarge(
  query: string,
  maxBytes = WORKTREE_SYMLINK_PATH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function getWorktreeSymlinkPathFilterState<T extends WorktreeSymlinkPathSuggestion>({
  query,
  suggestions,
  existingPaths,
  maxSuggestions = WORKTREE_SYMLINK_PATH_MAX_SUGGESTIONS
}: {
  query: string
  suggestions: readonly T[]
  existingPaths: readonly string[]
  maxSuggestions?: number
}): WorktreeSymlinkPathFilterState<T> {
  const queryTrimmed = query.trim().replace(/^\/+/, '')
  if (queryTrimmed && isWorktreeSymlinkPathQueryTooLarge(queryTrimmed)) {
    return {
      queryTrimmed: '',
      filtered: [],
      showLiteralItem: false,
      isQueryTooLarge: true
    }
  }

  const normalizedQuery = queryTrimmed.toLowerCase()
  const filtered = (
    normalizedQuery
      ? suggestions.filter((entry) => entry.name.toLowerCase().includes(normalizedQuery))
      : suggestions
  ).slice(0, maxSuggestions)
  const hasExactMatch = filtered.some((entry) => entry.name === queryTrimmed)

  return {
    queryTrimmed,
    filtered,
    showLiteralItem:
      queryTrimmed.length > 0 && !hasExactMatch && !existingPaths.includes(queryTrimmed),
    isQueryTooLarge: false
  }
}
