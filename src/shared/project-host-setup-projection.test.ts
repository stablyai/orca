import { describe, expect, it } from 'vitest'
import {
  projectHostSetupProjectionFromRepos,
  getProjectHostSetupsForProject,
  getProjectHostSetupWorktreeMeta,
  isGitHubBackedRepo
} from './project-host-setup-projection'
import type { Repo } from './types'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path' | 'displayName'>): Repo {
  return {
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...overrides
  }
}

describe('project host setup projection', () => {
  it('projects a legacy local repo into one project and one ready local setup', () => {
    const projection = projectHostSetupProjectionFromRepos(
      [repo({ id: 'repo-1', path: '/Users/alice/orca', displayName: 'orca' })],
      500
    )

    expect(projection.projects).toEqual([
      {
        id: 'repo:repo-1',
        displayName: 'orca',
        badgeColor: '#737373',
        kind: 'git',
        sourceRepoIds: ['repo-1'],
        createdAt: 100,
        updatedAt: 100
      }
    ])
    expect(projection.setups).toEqual([
      {
        id: 'repo-1',
        projectId: 'repo:repo-1',
        hostId: 'local',
        repoId: 'repo-1',
        path: '/Users/alice/orca',
        displayName: 'orca',
        kind: 'git',
        setupState: 'ready',
        setupMethod: 'legacy-repo',
        createdAt: 100,
        updatedAt: 100
      }
    ])
  })

  it('preserves host-local setup fields on SSH repos', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'remote-repo',
        path: '/home/alice/orca',
        displayName: 'orca',
        connectionId: 'openclaw 2',
        worktreeBasePath: '../worktrees',
        gitUsername: 'alice'
      })
    ])

    expect(projection.setups[0]).toMatchObject({
      id: 'remote-repo',
      hostId: 'ssh:openclaw%202',
      connectionId: 'openclaw 2',
      worktreeBasePath: '../worktrees',
      gitUsername: 'alice'
    })
  })

  it('preserves repo-backed setup method metadata', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'repo-1',
        path: '/Users/alice/orca',
        displayName: 'orca',
        projectHostSetupMethod: 'cloned'
      })
    ])

    expect(projection.setups[0]?.setupMethod).toBe('cloned')
  })

  it('groups repo checkouts with the same provider identity under one project', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'local-repo',
        path: '/Users/alice/orca',
        displayName: 'Orca',
        upstream: { owner: 'StablyAI', repo: 'Orca' }
      }),
      repo({
        id: 'remote-repo',
        path: '/home/alice/orca',
        displayName: 'orca',
        connectionId: 'gpu-vm',
        upstream: { owner: 'stablyai', repo: 'orca' }
      })
    ])

    expect(projection.projects).toHaveLength(1)
    expect(projection.projects[0]).toMatchObject({
      id: 'github:stablyai/orca',
      sourceRepoIds: ['local-repo', 'remote-repo'],
      providerIdentity: { provider: 'github', owner: 'StablyAI', repo: 'Orca' }
    })
    expect(getProjectHostSetupsForProject(projection.setups, 'github:stablyai/orca')).toHaveLength(
      2
    )
  })

  it('uses GitHub repo icon metadata as a provider identity fallback', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'local-repo',
        path: '/Users/alice/orca',
        displayName: 'Orca',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/stablyai.png?size=64',
          source: 'github',
          label: 'stablyai/orca'
        }
      }),
      repo({
        id: 'remote-repo',
        path: '/home/alice/orca',
        displayName: 'orca',
        connectionId: 'gpu-vm',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/stablyai.png?size=64',
          source: 'github',
          label: 'StablyAI/Orca'
        }
      })
    ])

    expect(projection.projects).toHaveLength(1)
    expect(projection.projects[0]).toMatchObject({
      id: 'github:stablyai/orca',
      sourceRepoIds: ['local-repo', 'remote-repo'],
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
    })
    expect(getProjectHostSetupsForProject(projection.setups, 'github:stablyai/orca')).toHaveLength(
      2
    )
  })

  it('does not guess that same-named folders are the same project without identity', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({ id: 'local-repo', path: '/Users/alice/app', displayName: 'app' }),
      repo({
        id: 'remote-repo',
        path: '/srv/app',
        displayName: 'app',
        connectionId: 'work-server'
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual([
      'repo:local-repo',
      'repo:remote-repo'
    ])
  })

  it('ignores malformed provider identity values', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'repo-1',
        path: '/Users/alice/orca',
        displayName: 'orca',
        upstream: { owner: 'stablyai', repo: 42 } as never
      })
    ])

    expect(projection.projects[0]?.id).toBe('repo:repo-1')
    expect(projection.projects[0]?.providerIdentity).toBeUndefined()
  })

  it('derives workspace ownership metadata from the repo setup', () => {
    const targetRepo = repo({
      id: 'remote-repo',
      path: '/home/alice/orca',
      displayName: 'orca',
      connectionId: 'openclaw 2',
      upstream: { owner: 'stablyai', repo: 'orca' }
    })
    const projection = projectHostSetupProjectionFromRepos([targetRepo])

    expect(getProjectHostSetupWorktreeMeta(projection.setups, targetRepo)).toEqual({
      projectId: 'github:stablyai/orca',
      hostId: 'ssh:openclaw%202',
      projectHostSetupId: 'remote-repo'
    })
  })
})

describe('isGitHubBackedRepo', () => {
  it('is true when an explicit upstream owner/repo is present', () => {
    const target = repo({
      id: 'r',
      path: '/r',
      displayName: 'r',
      upstream: { owner: 'stablyai', repo: 'orca' }
    })
    expect(isGitHubBackedRepo(target)).toBe(true)
  })

  it('is true when a GitHub-sourced avatar icon encodes the slug', () => {
    const target = repo({
      id: 'r',
      path: '/r',
      displayName: 'r',
      repoIcon: {
        type: 'image',
        src: 'https://github.com/stablyai.png?size=64',
        source: 'github',
        label: 'stablyai/orca'
      }
    })
    expect(isGitHubBackedRepo(target)).toBe(true)
  })

  it('is false for a non-GitHub icon and no upstream (GitLab/folder)', () => {
    const target = repo({
      id: 'r',
      path: '/r',
      displayName: 'r',
      repoIcon: { type: 'lucide', name: 'gitlab' }
    })
    expect(isGitHubBackedRepo(target)).toBe(false)
  })

  it('is false for a plain local repo with no provider signal', () => {
    expect(isGitHubBackedRepo(repo({ id: 'r', path: '/r', displayName: 'r' }))).toBe(false)
  })

  it('groups non-GitHub checkouts on different hosts by shared origin remote key', () => {
    const projection = projectHostSetupProjectionFromRepos(
      [
        repo({
          id: 'local-1',
          path: '/Users/alice/repos/app',
          displayName: 'app',
          originRemoteKey: 'forgejo.example.com/acme/app'
        }),
        repo({
          id: 'remote-1',
          path: '/home/codi/repos/app',
          displayName: 'app',
          connectionId: 'ssh-1',
          originRemoteKey: 'forgejo.example.com/acme/app'
        })
      ],
      500
    )
    // Both checkouts collapse into ONE project keyed on the shared origin remote.
    expect(projection.projects).toHaveLength(1)
    expect(projection.projects[0].id).toBe('git:forgejo.example.com/acme/app')
    expect(projection.projects[0].sourceRepoIds).toEqual(['local-1', 'remote-1'])
    // ...and each host keeps its own setup under that one project.
    expect(projection.setups.map((setup) => setup.projectId)).toEqual([
      'git:forgejo.example.com/acme/app',
      'git:forgejo.example.com/acme/app'
    ])
  })

  it('keeps a non-GitHub repo with no origin remote isolated as repo:<id>', () => {
    const projection = projectHostSetupProjectionFromRepos(
      [repo({ id: 'no-remote', path: '/r', displayName: 'r' })],
      500
    )
    expect(projection.projects[0].id).toBe('repo:no-remote')
  })
})
