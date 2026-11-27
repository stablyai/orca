import { describe, expect, it } from 'vitest'
import { resolveGitHubLandingPreset } from './task-github-search'

describe('resolveGitHubLandingPreset', () => {
  it('lands on PRs only when no tab or default was chosen', () => {
    expect(resolveGitHubLandingPreset(undefined, 'all')).toBe('prs')
    expect(resolveGitHubLandingPreset(undefined, undefined)).toBe('prs')
    expect(resolveGitHubLandingPreset(undefined, 'my-issues')).toBe('my-issues')
  })

  it('keeps the saved last tab, including a legacy saved mixed view', () => {
    expect(resolveGitHubLandingPreset('issues', 'all')).toBe('issues')
    expect(resolveGitHubLandingPreset('all', 'all')).toBe('issues')
    expect(resolveGitHubLandingPreset('my-prs', 'issues')).toBe('my-prs')
  })
})
