import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { findAddedGitHubRepo } from './github-added-repo-match'

function makeRepo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

describe('findAddedGitHubRepo', () => {
  it('matches a probed remote identity case-insensitively', () => {
    const repos = [
      makeRepo({
        gitRemoteIdentity: {
          canonicalKey: 'github.com/Acme/Orca',
          remoteName: 'origin',
          remoteUrl: 'git@github.com:Acme/Orca.git'
        }
      })
    ]
    expect(findAddedGitHubRepo(repos, 'acme/orca')?.id).toBe('repo-1')
  })

  it('matches the recorded upstream identity for forks', () => {
    const repos = [makeRepo({ upstream: { owner: 'Acme', repo: 'Orca' } })]
    expect(findAddedGitHubRepo(repos, 'acme/orca')?.id).toBe('repo-1')
  })

  it('returns null when nothing matches', () => {
    const repos = [
      makeRepo({
        gitRemoteIdentity: {
          canonicalKey: 'gitlab.com/acme/orca',
          remoteName: 'origin',
          remoteUrl: 'git@gitlab.com:acme/orca.git'
        }
      })
    ]
    expect(findAddedGitHubRepo(repos, 'acme/orca')).toBeNull()
    expect(findAddedGitHubRepo([], 'acme/orca')).toBeNull()
    expect(findAddedGitHubRepo(repos, '')).toBeNull()
  })
})
