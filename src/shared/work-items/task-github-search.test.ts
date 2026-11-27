import { describe, expect, it } from 'vitest'
import { getGitHubLandingQuery } from './task-github-search'

describe('getGitHubLandingQuery', () => {
  it('opens the saved last tab before the default, which falls back to PRs', () => {
    expect(getGitHubLandingQuery(undefined, 'all')).toBe('is:pr is:open')
    expect(getGitHubLandingQuery({ githubItemsPreset: 'issues' }, 'all')).toBe('is:issue is:open')
    // A saved legacy mixed view kept opening Issues.
    expect(getGitHubLandingQuery({ githubItemsPreset: 'all' }, 'prs')).toBe('is:issue is:open')
    expect(
      getGitHubLandingQuery({ githubItemsPreset: null, githubItemsQuery: ' bug ' }, 'all')
    ).toBe('bug')
  })
})
