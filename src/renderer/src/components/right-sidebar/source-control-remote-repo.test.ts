import { describe, expect, it } from 'vitest'
import {
  buildWebOrigin,
  parseRemoteRepo,
  resolveGitHostWebScheme
} from './source-control-remote-repo'

describe('resolveGitHostWebScheme', () => {
  it('defaults to https', () => {
    expect(resolveGitHostWebScheme('gitlab.company.test')).toBe('https')
    expect(resolveGitHostWebScheme('gitlab.company.test', {})).toBe('https')
  })

  it('honors an explicit host override', () => {
    expect(resolveGitHostWebScheme('gitlab.company.test', { 'gitlab.company.test': 'http' })).toBe(
      'http'
    )
  })

  it('matches bare hostname when the remote host includes a transport port', () => {
    expect(
      resolveGitHostWebScheme('gitlab.company.test:2222', { 'gitlab.company.test': 'http' })
    ).toBe('http')
  })
})

describe('buildWebOrigin', () => {
  it('keeps http(s) remote schemes and ports', () => {
    expect(buildWebOrigin('http:', 'gitlab.company.test:8080', 'gitlab.company.test')).toBe(
      'http://gitlab.company.test:8080'
    )
    expect(buildWebOrigin('https:', 'gitlab.com', 'gitlab.com')).toBe('https://gitlab.com')
  })

  it('defaults ssh remotes to https', () => {
    expect(buildWebOrigin('ssh:', 'git@host:2222', 'gitlab.company.test')).toBe(
      'https://gitlab.company.test'
    )
  })

  it('uses http for ssh remotes when the host is overridden', () => {
    expect(
      buildWebOrigin('ssh:', 'git@host:2222', 'gitlab.company.test', {
        'gitlab.company.test': 'http'
      })
    ).toBe('http://gitlab.company.test')
  })
})

describe('parseRemoteRepo web scheme', () => {
  it('builds https web URLs for ssh remotes by default', () => {
    expect(
      parseRemoteRepo('ssh://git@gitlab.company.test:2222/group/sub/orca.git', 'gitlab')
    ).toMatchObject({
      webBaseUrl: 'https://gitlab.company.test/group/sub/orca',
      provider: 'gitlab'
    })
  })

  it('builds http web URLs for ssh remotes when the host override is http', () => {
    expect(
      parseRemoteRepo('ssh://git@gitlab.company.test:2222/group/sub/orca.git', 'gitlab', {
        webSchemeByHost: { 'gitlab.company.test': 'http' }
      })
    ).toMatchObject({
      webBaseUrl: 'http://gitlab.company.test/group/sub/orca',
      provider: 'gitlab'
    })
  })

  it('applies the override to scp-style remotes', () => {
    expect(
      parseRemoteRepo('git@gitlab.company.test:group/sub/orca.git', 'gitlab', {
        webSchemeByHost: { 'gitlab.company.test': 'http' }
      })
    ).toMatchObject({
      webBaseUrl: 'http://gitlab.company.test/group/sub/orca'
    })
  })

  it('still prefers the remote scheme for http remotes even when an override exists', () => {
    expect(
      parseRemoteRepo('http://gitlab.company.test:8080/group/sub/orca.git', 'gitlab', {
        webSchemeByHost: { 'gitlab.company.test': 'https' }
      })
    ).toMatchObject({
      webBaseUrl: 'http://gitlab.company.test:8080/group/sub/orca'
    })
  })
})
