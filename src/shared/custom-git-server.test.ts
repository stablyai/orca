import { describe, expect, it } from 'vitest'
import {
  isCustomGitServerApiFlavor,
  matchCustomGitServerForHost,
  normalizeCustomGitServerApiBaseUrl,
  normalizeCustomGitServerHost
} from './custom-git-server'

describe('normalizeCustomGitServerHost', () => {
  it('lowercases a bare host', () => {
    expect(normalizeCustomGitServerHost('Git.Example.Com')).toBe('git.example.com')
  })

  it('extracts the host from an https URL (keeping the port)', () => {
    expect(normalizeCustomGitServerHost('https://git.example.com/team/repo')).toBe('git.example.com')
    expect(normalizeCustomGitServerHost('https://git.example.com:8443/x')).toBe(
      'git.example.com:8443'
    )
  })

  it('extracts the host from an scp-like remote', () => {
    expect(normalizeCustomGitServerHost('git@git.example.com:team/repo.git')).toBe('git.example.com')
  })

  it('drops a pasted trailing path from a bare host', () => {
    expect(normalizeCustomGitServerHost('git.example.com/')).toBe('git.example.com')
  })

  it('returns empty for blank input', () => {
    expect(normalizeCustomGitServerHost('   ')).toBe('')
  })
})

describe('normalizeCustomGitServerApiBaseUrl', () => {
  it('adds https:// when no scheme is present', () => {
    expect(normalizeCustomGitServerApiBaseUrl('git.example.com')).toBe('https://git.example.com')
  })

  it('trims trailing slashes and keeps an explicit scheme', () => {
    expect(normalizeCustomGitServerApiBaseUrl('http://git.example.com/')).toBe(
      'http://git.example.com'
    )
  })
})

describe('isCustomGitServerApiFlavor', () => {
  it('accepts known flavors and rejects others', () => {
    expect(isCustomGitServerApiFlavor('gitlab')).toBe(true)
    expect(isCustomGitServerApiFlavor('github')).toBe(false)
    expect(isCustomGitServerApiFlavor(null)).toBe(false)
  })
})

describe('matchCustomGitServerForHost', () => {
  const servers = [
    { id: '1', host: 'git.example.com' },
    { id: '2', host: 'ci.example.org:8443' }
  ]

  it('matches an exact host regardless of remote-URL form', () => {
    expect(matchCustomGitServerForHost('git@git.example.com:team/repo.git', servers)?.id).toBe('1')
    expect(matchCustomGitServerForHost('https://git.example.com/team/repo', servers)?.id).toBe('1')
  })

  it('falls back to a hostname match when the saved host has no port', () => {
    expect(matchCustomGitServerForHost('https://git.example.com:9000/x', servers)?.id).toBe('1')
  })

  it('does not match a different port when the saved host pins one', () => {
    expect(matchCustomGitServerForHost('https://ci.example.org/x', servers)).toBeNull()
    expect(matchCustomGitServerForHost('https://ci.example.org:8443/x', servers)?.id).toBe('2')
  })

  it('returns null for an unconfigured host', () => {
    expect(matchCustomGitServerForHost('github.com', servers)).toBeNull()
  })
})
