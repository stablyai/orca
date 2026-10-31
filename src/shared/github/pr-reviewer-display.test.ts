import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GitHubWorkItem } from './work-item-types'
import {
  GITHUB_PR_REVIEWER_INPUT_MAX_BYTES,
  getGitHubPRReviewerRows,
  isGitHubTeamReviewerLogin,
  parseGitHubReviewerInputLogins
} from './pr-reviewer-display'

function item(patch: Partial<GitHubWorkItem>): GitHubWorkItem {
  return patch as GitHubWorkItem
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GitHub PR reviewer display', () => {
  it('builds reviewer rows for requested and reviewed users', () => {
    expect(
      getGitHubPRReviewerRows(
        item({
          reviewRequests: [{ login: 'ExampleReviewer', name: null, avatarUrl: 'avatar-1' }],
          latestReviews: [
            { login: 'reviewer', state: 'APPROVED', avatarUrl: 'avatar-2' },
            { login: 'ExampleReviewer', state: 'COMMENTED', avatarUrl: 'avatar-1b' }
          ]
        })
      )
    ).toEqual([
      {
        login: 'ExampleReviewer',
        name: null,
        avatarUrl: 'avatar-1',
        stateLabel: 'Requested'
      },
      {
        login: 'reviewer',
        name: null,
        avatarUrl: 'avatar-2',
        stateLabel: 'Approved'
      }
    ])
  })

  it.each([
    ['acme/core-reviewers', true],
    ['octocat', false],
    ['app/dependabot', false],
    ['acme/', false],
    ['acme/team/extra', false]
  ])('classifies %s as a team reviewer: %s', (login, expected) => {
    expect(isGitHubTeamReviewerLogin(login)).toBe(expected)
  })

  it('parses pasted reviewer input without regex splitting', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const input = ['@ExampleReviewer,', String.fromCharCode(160), '@new-reviewer\nthird'].join('')

    expect(parseGitHubReviewerInputLogins(input)).toEqual([
      '@ExampleReviewer',
      '@new-reviewer',
      'third'
    ])
    expect(split).not.toHaveBeenCalled()
  })

  it('rejects oversized reviewer input before tokenizing pasted text', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const oversized = 'secret-reviewer,'.repeat(GITHUB_PR_REVIEWER_INPUT_MAX_BYTES)

    expect(parseGitHubReviewerInputLogins(oversized)).toEqual([])
    expect(split).not.toHaveBeenCalled()
  })
})
