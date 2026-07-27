import { describe, expect, it } from 'vitest'
import { deriveGitRemoteIdentities, normalizeGitRemoteUrl } from './git-remote-identity'

describe('normalizeGitRemoteUrl', () => {
  it('normalizes HTTPS and SSH GitHub remotes to the same canonical key', () => {
    expect(normalizeGitRemoteUrl('https://github.com/example/sample-app.git')).toBe(
      'github.com/example/sample-app'
    )
    expect(normalizeGitRemoteUrl('git@github.com:example/sample-app.git')).toBe(
      'github.com/example/sample-app'
    )
    expect(normalizeGitRemoteUrl('ssh://git@github.com/example/sample-app.git')).toBe(
      'github.com/example/sample-app'
    )
    expect(normalizeGitRemoteUrl('https://GitHub.com/example/sample-app.git')).toBe(
      'github.com/example/sample-app'
    )
  })

  it('preserves nested GitLab/self-hosted paths', () => {
    expect(normalizeGitRemoteUrl('git@gitlab.company.test:platform/tools/sample-app.git')).toBe(
      'gitlab.company.test/platform/tools/sample-app'
    )
  })

  it('ignores explicit URL ports in canonical keys', () => {
    expect(normalizeGitRemoteUrl('ssh://git@git.company.test:2222/team/sample-app.git')).toBe(
      'git.company.test/team/sample-app'
    )
  })

  it('preserves path case for case-sensitive hosted remotes', () => {
    expect(normalizeGitRemoteUrl('git@Git.Company.Test:Team/Sample-App.git')).toBe(
      'git.company.test/Team/Sample-App'
    )
    expect(normalizeGitRemoteUrl('https://git.company.test/Team/Sample-App.git')).toBe(
      'git.company.test/Team/Sample-App'
    )
  })

  it('rejects Windows local filesystem remotes', () => {
    expect(normalizeGitRemoteUrl('C:\\Repos\\sample-app.git')).toBeNull()
    expect(normalizeGitRemoteUrl('C:/Repos/sample-app.git')).toBeNull()
  })
})

describe('deriveGitRemoteIdentities', () => {
  it('lists every remote in primary precedence order and drops unusable ones', () => {
    expect(
      deriveGitRemoteIdentities(
        [
          'mirror\tC:\\Repos\\sample-app.git (fetch)',
          'origin\tgit@git.company.test:forks/sample-app.git (fetch)',
          'upstream\thttps://git.company.test/team/sample-app.git (fetch)'
        ].join('\r\n')
      )
    ).toEqual([
      {
        canonicalKey: 'git.company.test/team/sample-app',
        remoteName: 'upstream',
        remoteUrl: 'https://git.company.test/team/sample-app.git'
      },
      {
        canonicalKey: 'git.company.test/forks/sample-app',
        remoteName: 'origin',
        remoteUrl: 'git@git.company.test:forks/sample-app.git'
      }
    ])
  })

  it('ignores push lines and falls back to the first named remote', () => {
    expect(
      deriveGitRemoteIdentities(
        [
          'origin\tgit@git.company.test:forks/sample-app.git (fetch)',
          'origin\tgit@git.company.test:forks/sample-app.git (push)',
          'upstream\thttps://git.company.test/team/sample-app.git (fetch)',
          'upstream\thttps://git.company.test/team/sample-app.git (push)'
        ].join('\n')
      ).map((remote) => remote.remoteName)
    ).toEqual(['upstream', 'origin'])

    expect(
      deriveGitRemoteIdentities('mirror\tgit@git.company.test:team/sample-app.git (fetch)')
    ).toMatchObject([{ canonicalKey: 'git.company.test/team/sample-app', remoteName: 'mirror' }])
  })

  it('collapses remote names that share one URL', () => {
    expect(
      deriveGitRemoteIdentities(
        [
          'origin\tgit@git.company.test:team/sample-app.git (fetch)',
          'github\tgit@git.company.test:team/sample-app.git (fetch)'
        ].join('\n')
      )
    ).toEqual([
      {
        canonicalKey: 'git.company.test/team/sample-app',
        remoteName: 'origin',
        remoteUrl: 'git@git.company.test:team/sample-app.git'
      }
    ])
  })

  it('keeps two spellings of one canonical key so an endpoint port survives', () => {
    // The port lives in the URL, not the canonical key, and decides which project a
    // GHES clone belongs to; collapsing on the key alone would discard the only
    // spelling that can match a ported project.
    const remotes = deriveGitRemoteIdentities(
      [
        'upstream\tgit@ghe.company.test:team/sample-app.git (fetch)',
        'origin\thttps://ghe.company.test:8443/team/sample-app.git (fetch)'
      ].join('\n')
    )

    expect(remotes.map((remote) => remote.remoteUrl)).toEqual([
      'git@ghe.company.test:team/sample-app.git',
      'https://ghe.company.test:8443/team/sample-app.git'
    ])
    expect(new Set(remotes.map((remote) => remote.canonicalKey)).size).toBe(1)
  })
})
