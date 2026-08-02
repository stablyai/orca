import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

export type GitHubMentionOption = {
  login: string
  name?: string | null
}

export const GITHUB_MENTION_QUERY_MAX_BYTES = 2 * 1024
export const GITHUB_MENTION_OPTION_LIMIT = 8

export function isGitHubMentionQueryTooLarge(
  query: string,
  maxBytes = GITHUB_MENTION_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function filterGitHubMentionOptions<T extends GitHubMentionOption>(
  options: readonly T[],
  query: string,
  limit = GITHUB_MENTION_OPTION_LIMIT
): T[] {
  if (query && isGitHubMentionQueryTooLarge(query)) {
    return []
  }

  const normalizedQuery = query.toLowerCase()
  const filtered = normalizedQuery
    ? options.filter(
        (option) =>
          option.login.toLowerCase().includes(normalizedQuery) ||
          (option.name ?? '').toLowerCase().includes(normalizedQuery)
      )
    : options
  return filtered.slice(0, limit)
}
