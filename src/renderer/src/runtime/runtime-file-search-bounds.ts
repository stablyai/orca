import type { SearchOptions, SearchResult } from '../../../shared/types'

export const RUNTIME_FILE_SEARCH_TEXT_MAX_BYTES = 8 * 1024

export type RuntimeFileSearchRejectedField = 'query' | 'includePattern' | 'excludePattern'

export function createEmptyRuntimeFileSearchResult(): SearchResult {
  return { files: [], totalMatches: 0, truncated: false }
}

function getCodePointUtf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
}

export function isRuntimeFileSearchTextWithinLimit(
  text: string,
  maxBytes = RUNTIME_FILE_SEARCH_TEXT_MAX_BYTES
): boolean {
  let byteLength = 0
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index) ?? 0
    byteLength += getCodePointUtf8ByteLength(codePoint)
    if (byteLength > maxBytes) {
      return false
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }
  return true
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
