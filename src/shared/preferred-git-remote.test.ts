import { describe, expect, it } from 'vitest'
import { pickPreferredGitRemote } from './preferred-git-remote'

describe('pickPreferredGitRemote', () => {
  it('prefers origin even when another remote is listed first', () => {
    expect(pickPreferredGitRemote(['fork', 'origin'])).toBe('origin')
  })

  it('returns the sole remote when there is exactly one', () => {
    expect(pickPreferredGitRemote(['upstream'])).toBe('upstream')
  })

  it('ignores blank lines from `git remote` output', () => {
    expect(pickPreferredGitRemote(['fork\n', ' origin ', ''])).toBe('origin')
  })

  it('throws when there are no remotes', () => {
    expect(() => pickPreferredGitRemote([''])).toThrow('Repo has no configured git remotes.')
  })

  it('refuses to guess between multiple non-origin remotes', () => {
    expect(() => pickPreferredGitRemote(['fork', 'upstream'])).toThrow(
      'Repo has multiple remotes (fork, upstream) and no default is configured.'
    )
  })
})
