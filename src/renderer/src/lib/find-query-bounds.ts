import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'

export const FIND_QUERY_MAX_BYTES = 2 * 1024

export function isFindQueryTooLarge(query: string, maxBytes = FIND_QUERY_MAX_BYTES): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function getFindRequestQuery(query: string): string | null {
  return isFindQueryTooLarge(query) ? null : query
}
