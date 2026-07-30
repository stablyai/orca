import { describe, expect, it } from 'vitest'
import { githubRepoIdentityKey, isDefaultGitHubHost } from './github-repository-identity-key'

describe('GitHub repository identity', () => {
  it('normalizes case and harmless surrounding whitespace without merging GHES hosts', () => {
    expect(isDefaultGitHubHost(' GitHub.com ')).toBe(true)
    expect(githubRepoIdentityKey({ owner: 'Acme', repo: 'Widgets', host: ' GitHub.com ' })).toBe(
      'acme/widgets'
    )
    expect(
      githubRepoIdentityKey({ owner: 'Acme', repo: 'Widgets', host: ' GHE.EXAMPLE:8443 ' })
    ).toBe('ghe.example:8443/acme/widgets')
  })
})
