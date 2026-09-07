import { isUtf8ByteLengthWithinLimit } from '../../../shared/utf8-byte-limits'

export const RUNTIME_REPO_REF_SEARCH_QUERY_MAX_BYTES = 2 * 1024

export function isRuntimeRepoRefSearchQueryWithinLimit(
  query: string,
  maxBytes = RUNTIME_REPO_REF_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isUtf8ByteLengthWithinLimit(query, maxBytes)
}
