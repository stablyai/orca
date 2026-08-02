import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'

export const RUNTIME_PROVIDER_SEARCH_QUERY_MAX_BYTES = 8 * 1024

export function isRuntimeProviderSearchQueryWithinLimit(
  query: string | null | undefined,
  maxBytes = RUNTIME_PROVIDER_SEARCH_QUERY_MAX_BYTES
): boolean {
  if (query === null || query === undefined) {
    return true
  }
  return !measureUtf8ByteLength(query, { stopAfterBytes: maxBytes }).exceededLimit
}
