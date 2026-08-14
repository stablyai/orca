import type { SearchOptions, SearchResult } from '../../../shared/types'
import { isUtf8ByteLengthWithinLimit } from '../../../shared/utf8-byte-limits'

export const RUNTIME_FILE_SEARCH_TEXT_MAX_BYTES = 8 * 1024

export type RuntimeFileSearchRejectedField = 'query' | 'includePattern' | 'excludePattern'

export function createEmptyRuntimeFileSearchResult(): SearchResult {
  return { files: [], totalMatches: 0, truncated: false }
}

export function isRuntimeFileSearchTextWithinLimit(
  text: string,
  maxBytes = RUNTIME_FILE_SEARCH_TEXT_MAX_BYTES
): boolean {
  return isUtf8ByteLengthWithinLimit(text, maxBytes)
}

export function getRuntimeFileSearchRejectedField(
  options: Pick<SearchOptions, 'query' | 'includePattern' | 'excludePattern'>
): RuntimeFileSearchRejectedField | null {
  if (!isRuntimeFileSearchTextWithinLimit(options.query)) {
    return 'query'
  }
  if (
    options.includePattern !== undefined &&
    !isRuntimeFileSearchTextWithinLimit(options.includePattern)
  ) {
    return 'includePattern'
  }
  if (
    options.excludePattern !== undefined &&
    !isRuntimeFileSearchTextWithinLimit(options.excludePattern)
  ) {
    return 'excludePattern'
  }
  return null
}
