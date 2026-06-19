import { describe, expect, it } from 'vitest'

import type { GitHubWorkItem } from '../../../shared/types'
import {
  appendGitHubPRRequestedReviewers,
  getGitHubPRPrimaryReviewer,
  getGitHubPRReviewerRows,
  getGitHubPRReviewLabel,
  normalizeGitHubReviewerLogins
} from './github-pr-reviewer-display'

function item(patch: Partial<GitHubWorkItem>): GitHubWorkItem {
  return patch as GitHubWorkItem
}

describe('GitHub PR reviewer display', () => {
  it('shows the requested reviewer instead of a request count', () => {
    expect(
      getGitHubPRReviewLabel(
        item({
          reviewRequests: [{ login: 'ExampleReviewer', name: null, avatarUrl: '' }]
        })
      )
    ).toBe('ExampleReviewer')
  })

  it('keeps multiple reviewers compact while still naming the first reviewer', () => {
    expect(
      getGitHubPRReviewLabel(
        item({
          reviewRequests: [
            { login: 'ExampleReviewer', name: null, avatarUrl: '' },
            { login: 'agent-slack', name: null, avatarUrl: '' },
            { login: 'stably', name: null, avatarUrl: '' }
          ]
        })
      )
    ).toBe('ExampleReviewer +2')
  })

  it('preserves stronger review decision labels', () => {
    expect(
      getGitHubPRReviewLabel(
        item({
          reviewDecision: 'APPROVED',
          reviewRequests: [{ login: 'ExampleReviewer', name: null, avatarUrl: '' }]
        })
      )
    ).toBe('Approved')
  })

  it('falls back to reviewed users and empty metadata labels', () => {
    expect(getGitHubPRReviewLabel(item({ latestReviews: [{ login: 'reviewer' }] }))).toBe(
      'reviewer'
    )
    expect(getGitHubPRReviewLabel(item({ reviewRequests: [] }))).toBe('No reviewers')
    expect(getGitHubPRReviewLabel(item({}))).toBe('Reviewers')
  })

  it('returns the primary reviewer avatar without requiring another lookup', () => {
    expect(
      getGitHubPRPrimaryReviewer(
        item({
          reviewRequests: [
            {
              login: 'ExampleReviewer',
              name: null,
              avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
            }
          ]
        })
      )
    ).toEqual({
      login: 'ExampleReviewer',
      name: null,
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
    })
  })

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

  it('appends requested reviewers without duplicating existing logins', () => {
    expect(
      appendGitHubPRRequestedReviewers(
        [{ login: 'ExampleReviewer', name: null, avatarUrl: 'avatar-1' }],
        ['examplereviewer', '@new-reviewer']
      )
    ).toEqual([
      { login: 'ExampleReviewer', name: null, avatarUrl: 'avatar-1' },
      { login: 'new-reviewer', name: null, avatarUrl: '' }
    ])
  })

  it('normalizes reviewer input before sending it to GitHub', () => {
    expect(
      normalizeGitHubReviewerLogins(
        [' @ExampleReviewer ', 'examplereviewer', '@new-reviewer'],
        new Set(['existing'])
      )
    ).toEqual(['ExampleReviewer', 'new-reviewer'])
  })
})
