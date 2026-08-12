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
  it('accepts gitlab.com, conventional names, and knownHosts entries', () => {
    expect(isGitLabTaskHost('gitlab.com')).toBe(true)
    expect(isGitLabTaskHost('gitlab.example.com')).toBe(true)
    expect(isGitLabTaskHost('git.company.com', ['git.company.com'])).toBe(true)
    expect(isGitLabTaskHost('10.0.0.5', ['gitlab.com'])).toBe(false)
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
  })
})

describe('isGitLabTaskEligibleRepo', () => {
  it('keeps self-hosted, IP, SSH-pending, and still-GitLab repos', () => {
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
          id: 'ip',
          connectionId: 'builder',
          gitRemoteIdentity: {
            canonicalKey: '10.0.0.5/core/app',
            remoteName: 'origin',
            remoteUrl: 'git@10.0.0.5:core/app.git'
          }
        })
      )
    ).toBe(true)
    expect(isGitLabTaskEligibleRepo(repo({ id: 'pending', connectionId: 'ssh-1' }))).toBe(true)
  })

  it('excludes only authoritative non-GitLab (GitHub-backed) projects', () => {
    expect(
      isGitLabTaskEligibleRepo(
        repo({
          id: 'github',
          upstream: { owner: 'acme', repo: 'widgets' }
        })
      )
    ).toBe(false)
  })

  it('filters multi-repo lists without a host allowlist', () => {
    const eligible = getGitLabTaskEligibleRepos([
      repo({
        id: 'still-gitlab',
        gitRemoteIdentity: {
          canonicalKey: 'gitlab.example.com/team/alive',
          remoteName: 'origin',
          remoteUrl: 'git@gitlab.example.com:team/alive.git'
        }
      }),
      repo({
        id: 'migrated-candidate',
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
    ])
    // Why: migrated stays queryable until per-repo not_found; GitHub is out.
    expect(eligible.map((r) => r.id).sort()).toEqual(['migrated-candidate', 'still-gitlab'])
  })
})
