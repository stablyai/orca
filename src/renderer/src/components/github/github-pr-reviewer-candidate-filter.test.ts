import { describe, expect, it } from 'vitest'
import type { GitHubAssignableUser } from '../../../../shared/github/pull-request-types'
import {
  GITHUB_PR_REVIEWER_QUERY_MAX_BYTES,
  filterGitHubPRReviewerCandidates,
  getGitHubPRReviewerQueryState
} from './github-pr-reviewer-candidate-filter'

describe('github-pr-reviewer-candidate-filter', () => {
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
