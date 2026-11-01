import { describe, expect, it } from 'vitest'

import { getGitHubTaskKind, scopeGitHubTaskSearch } from '../../../../../shared/task-github-search'

describe('getGitHubTaskKind', () => {
  it('lets an explicit issue query override a PR-focused preset', () => {
    for (const preset of ['prs', 'my-prs', 'review'] as const) {
      expect(getGitHubTaskKind(preset, 'is:issue is:open')).toBe('issues')
      expect(getGitHubTaskKind(preset, 'is:"issue"')).toBe('issues')
      expect(getGitHubTaskKind(preset, 'label:is:issue')).toBe('prs')
    }
  })
})

describe('scopeGitHubTaskSearch', () => {
  it('lets a parsed pr scope override the caller kind', () => {
    expect(scopeGitHubTaskSearch('is:draft', 'issues')).toBe('is:pr is:draft')
  })

  it('lets a parsed issue scope override the caller kind', () => {
    // Quoting hides scope from the literal regex, but parsed scope still overrides the caller kind.
    expect(scopeGitHubTaskSearch('is:"issue"', 'prs')).toBe('is:"issue"')
  })
})
