import { describe, expect, it } from 'vitest'
import { pickPreferredGitRemote } from './preferred-git-remote'

describe('pickPreferredGitRemote', () => {
  it('refuses to guess between multiple non-origin remotes', () => {
    expect(() => pickPreferredGitRemote(['fork', 'upstream'])).toThrow(
      'Repo has multiple remotes (fork, upstream) and no default is configured.'
    )
  })
})
