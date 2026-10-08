import { describe, expect, it } from 'vitest'
import { buildGitHubFileUrl } from './github-file-url'

describe('buildGitHubFileUrl', () => {
  const base = {
    originRemoteUrl: 'git@github.com:acme/repo.git',
    branch: 'refs/heads/feature/fix',
    filePath: 'src/a file.ts'
  }

  it('builds a URL for current branch and relative file path', () => {
    expect(buildGitHubFileUrl(base)).toBe(
      'https://github.com/acme/repo/blob/feature/fix/src/a%20file.ts'
    )
  })

  it.each([
    { ...base, originRemoteUrl: undefined },
    { ...base, originRemoteUrl: 'git@gitlab.com:acme/repo.git' },
    { ...base, branch: '' }
  ])('returns null when origin GitHub URL and branch are unavailable', (input) => {
    expect(buildGitHubFileUrl(input)).toBeNull()
  })
})
