import { isClipboardTextByteLengthOverLimit } from '../clipboard-text'

export const GITHUB_WORK_ITEMS_QUERY_MAX_BYTES = 8 * 1024

/**
 * The Search API's free-text 422 wording is the only signal separating a
 * permanently unreachable page (past the first 1000 matches) from a transient failure.
 */
export const GITHUB_SEARCH_RESULT_WINDOW_ERROR_PATTERN = /first 1000 search results/i

export function isGitHubWorkItemsQueryTooLarge(
  query: string,
  maxBytes = GITHUB_WORK_ITEMS_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}
