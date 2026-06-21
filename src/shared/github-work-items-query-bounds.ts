import { isClipboardTextByteLengthOverLimit } from './clipboard-text'

export const GITHUB_WORK_ITEMS_QUERY_MAX_BYTES = 8 * 1024

export function isGitHubWorkItemsQueryTooLarge(
  query: string,
  maxBytes = GITHUB_WORK_ITEMS_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}
