import { describe, expect, it } from 'vitest'
import { gitLabHostFromUrl, normalizeGitLabUrl } from './gitlab-instance-url'

describe('GitLab instance setting', () => {
  it('normalizes configured URLs and preserves non-default ports', () => {
    expect(normalizeGitLabUrl('  HTTPS://GitLab.Example.com:8443/// ')).toBe(
      'https://gitlab.example.com:8443'
    )
    expect(gitLabHostFromUrl('https://gitlab.example.com:8443')).toBe('gitlab.example.com:8443')
  })

  it('drops a default port so the host matches what git remotes report', () => {
    expect(normalizeGitLabUrl('https://gitlab.example.com:443')).toBe('https://gitlab.example.com')
    expect(gitLabHostFromUrl('https://gitlab.example.com:443')).toBe('gitlab.example.com')
  })

  it('discards any path, so only the instance root is stored', () => {
    expect(normalizeGitLabUrl('https://gitlab.example.com/group/project')).toBe(
      'https://gitlab.example.com'
    )
  })

  it('rejects invalid or credential-bearing URLs without selecting a host', () => {
    expect(normalizeGitLabUrl('not a url')).toBe('')
    expect(normalizeGitLabUrl('gitlab.example.com')).toBe('')
    expect(normalizeGitLabUrl('ssh://gitlab.example.com')).toBe('')
    expect(normalizeGitLabUrl('https://token@gitlab.example.com')).toBe('')
    expect(normalizeGitLabUrl('https://gitlab.example.com?token=x')).toBe('')
    expect(gitLabHostFromUrl('')).toBe('')
  })
})
