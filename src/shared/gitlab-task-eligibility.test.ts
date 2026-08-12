import { describe, expect, it } from 'vitest'
import type { Repo } from './types'
import {
  extractGitRemoteHost,
  getGitLabTaskEligibleRepos,
  isGitLabTaskEligibleRepo,
  isGitLabTaskHost
} from './gitlab-task-eligibility'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: `/repos/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...overrides
  }
}

describe('isGitLabTaskHost', () => {
  it('accepts gitlab.com and common self-hosted names', () => {
    expect(isGitLabTaskHost('gitlab.com')).toBe(true)
    expect(isGitLabTaskHost('gitlab.example.com')).toBe(true)
    expect(isGitLabTaskHost('corp.gitlab.example')).toBe(true)
  })

  it('accepts hosts listed in knownHosts including ported entries', () => {
    expect(isGitLabTaskHost('git.company.com', ['git.company.com'])).toBe(true)
    expect(isGitLabTaskHost('git.company.com:8443', ['git.company.com'])).toBe(true)
    expect(isGitLabTaskHost('git.company.com:8443', ['git.company.com:8443'])).toBe(true)
    expect(isGitLabTaskHost('git.company.com:3000', ['git.company.com:8443'])).toBe(false)
  })

  it('rejects non-GitLab hosts when knownHosts are authoritative', () => {
    expect(isGitLabTaskHost('github.com', ['gitlab.com'])).toBe(false)
    expect(isGitLabTaskHost('10.0.0.5', ['gitlab.com', 'gitlab.example.com'])).toBe(false)
    expect(isGitLabTaskHost('git.internal.example', ['gitlab.com'])).toBe(false)
  })
})

describe('extractGitRemoteHost', () => {
  it('reads host from remote URL and canonical key', () => {
    expect(
      extractGitRemoteHost(
        repo({
          id: 'a',
          gitRemoteIdentity: {
            canonicalKey: 'gitlab.example.com/team/app',
            remoteName: 'origin',
            remoteUrl: 'git@gitlab.example.com:team/app.git'
          }
        })
      )
    ).toBe('gitlab.example.com')
    expect(
      extractGitRemoteHost(
        repo({
          id: 'b',
          gitRemoteIdentity: {
            canonicalKey: '10.0.0.5/core/app',
            remoteName: 'origin',
            remoteUrl: 'git@10.0.0.5:core/app.git'
          }
        })
      )
    ).toBe('10.0.0.5')
  })
})

describe('isGitLabTaskEligibleRepo / STA-3902', () => {
  it('keeps a still-GitLab project eligible', () => {
    expect(
      isGitLabTaskEligibleRepo(
        repo({
          id: 'still-gitlab',
          gitRemoteIdentity: {
            canonicalKey: 'gitlab.example.com/team/alive',
            remoteName: 'origin',
            remoteUrl: 'git@gitlab.example.com:team/alive.git'
          }
        })
      )
    ).toBe(true)
  })

  it('keeps self-hosted and IP remotes eligible when knownHosts are unknown', () => {
    // Why: without glab knownHosts, host heuristics must not drop valid self-hosted GitLab.
    expect(
      isGitLabTaskEligibleRepo(
        repo({
          id: 'self-hosted',
          gitRemoteIdentity: {
            canonicalKey: 'git.company.com/team/app',
            remoteName: 'origin',
            remoteUrl: 'git@git.company.com:team/app.git'
          }
        })
      )
    ).toBe(true)
    expect(
      isGitLabTaskEligibleRepo(
        repo({
          id: 'ip-hosted',
          gitRemoteIdentity: {
            canonicalKey: '10.0.0.5/core/app',
            remoteName: 'origin',
            remoteUrl: 'git@10.0.0.5:core/app.git'
          }
        })
      )
    ).toBe(true)
  })

  it('excludes a migrated non-GitLab host only with authoritative knownHosts', () => {
    const migrated = repo({
      id: 'migrated-off-gitlab',
      gitRemoteIdentity: {
        canonicalKey: '10.0.0.5/core/migrated',
        remoteName: 'origin',
        remoteUrl: 'git@10.0.0.5:core/migrated.git'
      }
    })
    expect(isGitLabTaskEligibleRepo(migrated)).toBe(true)
    expect(isGitLabTaskEligibleRepo(migrated, ['gitlab.com', 'gitlab.example.com'])).toBe(false)
  })

  it('keeps authenticated self-hosted hosts when listed in knownHosts', () => {
    const selfHosted = repo({
      id: 'self-hosted',
      gitRemoteIdentity: {
        canonicalKey: 'git.company.com/team/app',
        remoteName: 'origin',
        remoteUrl: 'git@git.company.com:team/app.git'
      }
    })
    expect(isGitLabTaskEligibleRepo(selfHosted, ['gitlab.com', 'git.company.com'])).toBe(true)
  })

  it('excludes GitHub-backed projects from the GitLab task source', () => {
    expect(
      isGitLabTaskEligibleRepo(
        repo({
          id: 'github',
          upstream: { owner: 'acme', repo: 'widgets' }
        })
      )
    ).toBe(false)
  })

  it('keeps a pending remote-identity probe visible', () => {
    expect(isGitLabTaskEligibleRepo(repo({ id: 'ssh-pending', connectionId: 'builder' }))).toBe(
      true
    )
  })

  it('filters multi-repo selection with knownHosts without dropping self-hosted GitLab', () => {
    const eligible = getGitLabTaskEligibleRepos(
      [
        repo({
          id: 'still-gitlab',
          gitRemoteIdentity: {
            canonicalKey: 'gitlab.example.com/team/alive',
            remoteName: 'origin',
            remoteUrl: 'git@gitlab.example.com:team/alive.git'
          }
        }),
        repo({
          id: 'self-hosted',
          gitRemoteIdentity: {
            canonicalKey: 'git.company.com/team/app',
            remoteName: 'origin',
            remoteUrl: 'git@git.company.com:team/app.git'
          }
        }),
        repo({
          id: 'migrated-off-gitlab',
          gitRemoteIdentity: {
            canonicalKey: '10.0.0.5/core/migrated',
            remoteName: 'origin',
            remoteUrl: 'git@10.0.0.5:core/migrated.git'
          }
        }),
        repo({
          id: 'github',
          upstream: { owner: 'acme', repo: 'widgets' }
        })
      ],
      ['gitlab.com', 'gitlab.example.com', 'git.company.com']
    )
    expect(eligible.map((r) => r.id).sort()).toEqual(['self-hosted', 'still-gitlab'])
  })
})
