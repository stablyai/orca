import { describe, expect, it } from 'vitest'
import { deriveGitRemoteIdentity, normalizeGitRemoteUrl } from './git-remote-identity'

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

describe('deriveGitRemoteIdentity', () => {
  it('prefers upstream, then origin, then the first named remote', () => {
    expect(
      deriveGitRemoteIdentity(
        [
          'origin\tgit@git.company.test:forks/sample-app.git (fetch)',
          'origin\tgit@git.company.test:forks/sample-app.git (push)',
          'upstream\thttps://git.company.test/team/sample-app.git (fetch)',
          'upstream\thttps://git.company.test/team/sample-app.git (push)'
        ].join('\n')
      )
    ).toEqual({
      canonicalKey: 'git.company.test/team/sample-app',
      remoteName: 'upstream',
      remoteUrl: 'https://git.company.test/team/sample-app.git'
    })

    expect(
      deriveGitRemoteIdentity('origin\tgit@git.company.test:team/sample-app.git (fetch)')
    ).toMatchObject({
      canonicalKey: 'git.company.test/team/sample-app',
      remoteName: 'origin'
    })

    expect(
      deriveGitRemoteIdentity('mirror\tgit@git.company.test:team/sample-app.git (fetch)')
    ).toMatchObject({
      canonicalKey: 'git.company.test/team/sample-app',
      remoteName: 'mirror'
    })
  })
})
