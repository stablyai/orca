import type { PRInfo, PRRefreshOutcome } from './types'

export type GitHubPRForBranchResponse = PRRefreshOutcome | PRInfo | null

// Legacy hosts return PRInfo|null; current hosts return a classified refresh outcome.
export function normalizeGitHubPRForBranchOutcome(
  response: GitHubPRForBranchResponse,
  fetchedAt = Date.now()
): PRRefreshOutcome {
  if (response && typeof response === 'object' && 'kind' in response) {
    return response
  }
  return response ? { kind: 'found', pr: response, fetchedAt } : { kind: 'no-pr', fetchedAt }
}
