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

  it('keeps same-named github.com and GHES repositories in separate projects', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'dotcom-repo',
        path: '/work/dotcom',
        displayName: 'widgets',
        upstream: { owner: 'acme', repo: 'widgets', host: 'github.com' }
      }),
      repo({
        id: 'enterprise-repo',
        path: '/work/enterprise',
        displayName: 'widgets',
        upstream: { owner: 'acme', repo: 'widgets', host: 'github.acme.test' }
      })
    ])

    expect(projection.projects).toHaveLength(2)
    expect(projection.projects.map((project) => project.id)).toEqual([
      'github:acme/widgets',
      'github:github.acme.test/acme/widgets'
    ])
    expect(projection.projects[1]?.providerIdentity).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'widgets',
      host: 'github.acme.test'
    })
  })

  it('groups GHES icon identities only when their hosts match', () => {
    const enterpriseIcon = (host: string) => ({
      type: 'image' as const,
      src: `https://${host}/acme.png?size=64`,
      source: 'github' as const,
      label: 'acme/widgets'
    })
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'enterprise-local',
        path: '/work/local',
        displayName: 'widgets',
        repoIcon: enterpriseIcon('github.acme.test')
      }),
      repo({
        id: 'enterprise-ssh',
        path: '/work/ssh',
        displayName: 'widgets',
        connectionId: 'builder',
        repoIcon: enterpriseIcon('github.acme.test')
      }),
      repo({
        id: 'other-enterprise',
        path: '/work/other',
        displayName: 'widgets',
        repoIcon: enterpriseIcon('github.other.test')
      })
    ])

    expect(projection.projects).toHaveLength(2)
    expect(projection.projects[0]).toMatchObject({
      id: 'github:github.acme.test/acme/widgets',
      sourceRepoIds: ['enterprise-local', 'enterprise-ssh']
    })
    expect(projection.projects[1]?.id).toBe('github:github.other.test/acme/widgets')
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

  it('uses git remote identity as a provider identity fallback', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'canonical-local-repo',
        path: '/Users/alice/stably/orca',
        displayName: 'orca',
        gitRemoteIdentity: {
          canonicalKey: 'github.com/stablyai/orca',
          remoteName: 'origin',
          remoteUrl: 'git@github.com:stablyai/orca.git'
        }
      }),
      repo({
        id: 'old-branch-checkout',
        path: '/Users/alice/orca/workspaces/orca/re-enable-webgl-for-remote-runtime-terminals',
        displayName: 're-enable-webgl-for-remote-runtime-terminals',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/stablyai.png?size=64',
          source: 'github',
          label: 'stablyai/orca'
        }
      })
    ])

    expect(projection.projects).toHaveLength(1)
    expect(projection.projects[0]).toMatchObject({
      id: 'github:stablyai/orca',
      displayName: 'orca',
      sourceRepoIds: ['canonical-local-repo', 'old-branch-checkout'],
      providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' }
    })
  })

  it('uses a GHES canonical remote identity when the remote URL is unavailable', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'enterprise-repo',
        path: '/work/widgets',
        displayName: 'widgets',
        gitRemoteIdentity: {
          canonicalKey: 'github.acme.test/acme/widgets',
          remoteName: 'origin',
          remoteUrl: 'not-a-remote'
        }
      })
    ])

    expect(projection.projects[0]).toMatchObject({
      id: 'github:github.acme.test/acme/widgets',
      providerIdentity: {
        provider: 'github',
        owner: 'acme',
        repo: 'widgets',
        host: 'github.acme.test'
      }
    })
  })

  it('preserves GHES HTTP ports but drops SSH transport ports from remote identity', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'https-repo',
        path: '/work/https',
        displayName: 'widgets',
        gitRemoteIdentity: {
          canonicalKey: 'github.acme.test/acme/widgets',
          remoteName: 'origin',
          remoteUrl: 'https://github.acme.test:8443/acme/widgets.git'
        }
      }),
      repo({
        id: 'ssh-repo',
        path: '/work/ssh',
        displayName: 'widgets',
        gitRemoteIdentity: {
          canonicalKey: 'github.acme.test/acme/widgets',
          remoteName: 'origin',
          remoteUrl: 'ssh://git@github.acme.test:2222/acme/widgets.git'
        }
      })
    ])

    expect(projection.projects.map((project) => project.providerIdentity?.host)).toEqual([
      'github.acme.test:8443',
      'github.acme.test'
    ])
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

  it('groups same-project records across local, SSH, and runtime hosts by git remote identity', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'local-sample-app',
        path: '/Users/alice/work/sample-app',
        displayName: 'sample-app',
        gitRemoteIdentity: {
          canonicalKey: 'git.company.test/team/sample-app',
          remoteName: 'origin',
          remoteUrl: 'git@git.company.test:team/sample-app.git'
        }
      }),
      repo({
        id: 'ssh-sample-app',
        path: '/home/alice/src/sample-app',
        displayName: 'sample-app',
        connectionId: 'build server',
        gitRemoteIdentity: {
          canonicalKey: 'git.company.test/team/sample-app',
          remoteName: 'origin',
          remoteUrl: 'https://git.company.test/team/sample-app.git'
        }
      }),
      repo({
        id: 'runtime-sample-app',
        path: '/workspace/sample-app',
        displayName: 'sample-app',
        executionHostId: 'runtime:dev-container',
        gitRemoteIdentity: {
          canonicalKey: 'git.company.test/team/sample-app',
          remoteName: 'origin',
          remoteUrl: 'ssh://git@git.company.test/team/sample-app.git'
        }
      })
    ])

    expect(projection.projects).toHaveLength(1)
    expect(projection.projects[0]).toMatchObject({
      id: 'git:git.company.test/team/sample-app',
      displayName: 'sample-app',
      sourceRepoIds: ['local-sample-app', 'ssh-sample-app', 'runtime-sample-app'],
      gitRemoteIdentity: {
        canonicalKey: 'git.company.test/team/sample-app',
        remoteName: 'origin'
      }
    })
    expect(projection.setups.map((setup) => setup.hostId)).toEqual([
      'local',
      'ssh:build%20server',
      'runtime:dev-container'
    ])
    expect(
      getProjectHostSetupsForProject(projection.setups, 'git:git.company.test/team/sample-app')
    ).toHaveLength(3)
  })

  it('keeps same-named cross-host records separate when there is no shared repo identity', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'local-sample-app',
        path: '/Users/alice/work/sample-app',
        displayName: 'sample-app'
      }),
      repo({
        id: 'ssh-sample-app',
        path: '/srv/unrelated/sample-app',
        displayName: 'sample-app',
        connectionId: 'staging server'
      }),
      repo({
        id: 'runtime-sample-app',
        path: '/workspace/sample-app',
        displayName: 'sample-app',
        executionHostId: 'runtime:preview'
      })
    ])

    // Why: display names are labels, not identity. A future fix needs a
    // normalized git remote identity or an explicit user link before merging.
    expect(projection.projects).toHaveLength(3)
  })

  it('does not collapse case-distinct remote paths for self-hosted git remotes', () => {
    const projection = projectHostSetupProjectionFromRepos([
      repo({
        id: 'uppercase-repo',
        path: '/Users/alice/work/sample-app',
        displayName: 'sample-app',
        gitRemoteIdentity: {
          canonicalKey: 'git.company.test/Team/Sample-App',
          remoteName: 'origin',
          remoteUrl: 'git@git.company.test:Team/Sample-App.git'
        }
      }),
      repo({
        id: 'lowercase-repo',
        path: '/home/alice/src/sample-app',
        displayName: 'sample-app',
        connectionId: 'build server',
        gitRemoteIdentity: {
          canonicalKey: 'git.company.test/team/sample-app',
          remoteName: 'origin',
          remoteUrl: 'git@git.company.test:team/sample-app.git'
        }
      })
    ])

    expect(projection.projects.map((project) => project.id)).toEqual([
      'git:git.company.test/Team/Sample-App',
      'git:git.company.test/team/sample-app'
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
})
