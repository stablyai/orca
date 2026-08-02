import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import type { GitHubAssignableUser } from '../../../../shared/types'

export type GitHubPRReviewerQueryState = {
  query: string
  isTooLarge: boolean
}

export const GITHUB_PR_REVIEWER_QUERY_MAX_BYTES = 2 * 1024

export function isGitHubPRReviewerQueryTooLarge(
  query: string,
  maxBytes = GITHUB_PR_REVIEWER_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function getGitHubPRReviewerQueryState(input: string): GitHubPRReviewerQueryState {
  const query = input.trim().replace(/^@/, '')
  if (query && isGitHubPRReviewerQueryTooLarge(query)) {
    return { query: '', isTooLarge: true }
  }
  return { query: query.toLowerCase(), isTooLarge: false }
}

export function filterGitHubPRReviewerCandidates({
  candidates,
  queryState
}: {
  candidates: readonly GitHubAssignableUser[]
  queryState: GitHubPRReviewerQueryState
}): GitHubAssignableUser[] {
  if (queryState.isTooLarge) {
    return []
  }

  const query = queryState.query
  return [...candidates]
    .filter((user) => {
      const login = user.login.toLowerCase()
      return (
        query.length === 0 ||
        login.includes(query) ||
        (user.name ?? '').toLowerCase().includes(query)
      )
    })
    .sort((a, b) => {
      const aLogin = a.login.toLowerCase()
      const bLogin = b.login.toLowerCase()
      const aStarts = aLogin.startsWith(query)
      const bStarts = bLogin.startsWith(query)
      if (aStarts !== bStarts) {
        return aStarts ? -1 : 1
      }
      return a.login.localeCompare(b.login)
    })
}
