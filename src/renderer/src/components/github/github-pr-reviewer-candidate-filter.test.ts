import { describe, expect, it } from 'vitest'
import type { GitHubAssignableUser } from '../../../../shared/github/pull-request-types'
import {
  GITHUB_PR_REVIEWER_QUERY_MAX_BYTES,
  filterGitHubPRReviewerCandidates,
  getGitHubPRReviewerQueryState
} from './github-pr-reviewer-candidate-filter'

function user(login: string, name: string | null = null): GitHubAssignableUser {
  return { login, name, avatarUrl: '' }
}

describe('github-pr-reviewer-candidate-filter', () => {
  it('enforces the query budget by UTF-8 byte length', () => {
    const query = 'é'.repeat(GITHUB_PR_REVIEWER_QUERY_MAX_BYTES)

    expect(query.length).toBe(GITHUB_PR_REVIEWER_QUERY_MAX_BYTES)
    expect(getGitHubPRReviewerQueryState(query)).toEqual({ query: '', isTooLarge: true })
    expect(
      filterGitHubPRReviewerCandidates({
        candidates: [user('octocat')],
        queryState: getGitHubPRReviewerQueryState(query)
      })
    ).toEqual([])
  })

  it('rejects oversized pasted reviewer queries before reading candidate metadata', () => {
    const oversizedQuery = 'secret-reviewer-query'.repeat(GITHUB_PR_REVIEWER_QUERY_MAX_BYTES)
    const candidate = {
      get login(): string {
        throw new Error('oversized reviewer queries must not scan logins')
      },
      get name(): string {
        throw new Error('oversized reviewer queries must not scan names')
      },
      avatarUrl: ''
    } as GitHubAssignableUser

    expect(
      filterGitHubPRReviewerCandidates({
        candidates: [candidate],
        queryState: getGitHubPRReviewerQueryState(oversizedQuery)
      })
    ).toEqual([])
  })
})
