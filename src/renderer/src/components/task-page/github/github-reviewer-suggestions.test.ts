import { describe, expect, it } from 'vitest'
import {
  buildRequestedReviewUsers,
  mergeReviewerSuggestions,
  resolveTaskPullRequestRepo,
  sameOptionalGitHubOwnerRepo
} from './github-reviewer-suggestions'

describe('sameOptionalGitHubOwnerRepo', () => {
  it('treats two missing values as equal', () => {
    expect(sameOptionalGitHubOwnerRepo(null, undefined)).toBe(true)
  })

  it('treats a missing value as unequal to a repo', () => {
    expect(
      sameOptionalGitHubOwnerRepo(null, { owner: 'acme', repo: 'orca', host: 'github.com' })
    ).toBe(false)
  })

  it('separates the same owner/repo on different hosts', () => {
    expect(
      sameOptionalGitHubOwnerRepo(
        { owner: 'acme', repo: 'orca', host: 'github.com' },
        { owner: 'acme', repo: 'orca', host: 'github.example.com' }
      )
    ).toBe(false)
  })
})

describe('resolveTaskPullRequestRepo', () => {
  it('keeps prRepo host when present', () => {
    expect(
      resolveTaskPullRequestRepo({
        prRepo: { owner: 'acme', repo: 'orca', host: 'github.example.com' },
        url: 'https://github.com/other/repo/pull/1'
      })
    ).toEqual({ owner: 'acme', repo: 'orca', host: 'github.example.com' })
  })

  it('falls back to the URL slug and pins github.com', () => {
    expect(
      resolveTaskPullRequestRepo({
        prRepo: undefined,
        url: 'https://github.com/acme/orca/pull/12'
      })
    ).toEqual({ owner: 'acme', repo: 'orca', host: 'github.com' })
  })
})

describe('mergeReviewerSuggestions', () => {
  it('dedupes by login and prefers a later avatar', () => {
    expect(
      mergeReviewerSuggestions(
        [{ login: 'Ada', name: 'Ada', avatarUrl: 'https://example/ada.png' }],
        [{ login: 'ada', name: null, avatarUrl: '' }]
      )
    ).toEqual([{ login: 'ada', name: 'Ada', avatarUrl: 'https://example/ada.png' }])
  })
})

describe('buildRequestedReviewUsers', () => {
  it('keeps existing requests and fills missing logins from candidates', () => {
    expect(
      buildRequestedReviewUsers(
        ['octocat', 'hubot'],
        [{ login: 'hubot', name: 'Hubot', avatarUrl: 'https://example/hubot.png' }],
        [{ login: 'octocat', name: 'Octo', avatarUrl: '' }]
      )
    ).toEqual([
      { login: 'octocat', name: 'Octo', avatarUrl: '' },
      { login: 'hubot', name: 'Hubot', avatarUrl: 'https://example/hubot.png' }
    ])
  })
})
