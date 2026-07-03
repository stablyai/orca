import { describe, expect, it } from 'vitest'
import type { GitHubAssignableUser } from '../../../../shared/types'
import {
  GITHUB_PR_REVIEWER_QUERY_MAX_BYTES,
  filterGitHubPRReviewerCandidates,
  getGitHubPRReviewerQueryState,
  isGitHubPRReviewerQueryTooLarge
} from './github-pr-reviewer-candidate-filter'

function user(login: string, name: string | null = null): GitHubAssignableUser {
  return { login, name, avatarUrl: '' }
}

describe('github-pr-reviewer-candidate-filter', () => {
  it('normalizes typed reviewer queries with optional at-prefixes', () => {
    expect(getGitHubPRReviewerQueryState('  @OctoCat  ')).toEqual({
      query: 'octocat',
      isTooLarge: false
    })
  })

  it('filters reviewer candidates by login or display name and prioritizes login prefixes', () => {
    const candidates = [
      user('zebra-reviewer', 'Release Manager'),
      user('alice', 'Feature Reviewer'),
      user('review-bot', 'Automation')
    ]

    expect(
      filterGitHubPRReviewerCandidates({
        candidates,
        queryState: getGitHubPRReviewerQueryState('review')
      }).map((candidate) => candidate.login)
    ).toEqual(['review-bot', 'alice', 'zebra-reviewer'])
  })

  it('enforces the query budget by UTF-8 byte length', () => {
    const query = 'é'.repeat(GITHUB_PR_REVIEWER_QUERY_MAX_BYTES)

    expect(query.length).toBe(GITHUB_PR_REVIEWER_QUERY_MAX_BYTES)
    expect(isGitHubPRReviewerQueryTooLarge(query)).toBe(true)
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

    expect(isGitHubPRReviewerQueryTooLarge(oversizedQuery)).toBe(true)
    expect(
      filterGitHubPRReviewerCandidates({
        candidates: [candidate],
        queryState: getGitHubPRReviewerQueryState(oversizedQuery)
      })
    ).toEqual([])
  })
})
