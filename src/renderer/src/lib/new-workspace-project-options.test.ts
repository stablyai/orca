import { describe, expect, it } from 'vitest'
import {
  NEW_WORKSPACE_PROJECT_OPTION_QUERY_MAX_BYTES,
  buildNewWorkspaceFolderSourceOptions,
  buildNewWorkspaceProjectOptions,
  getRepoIdFromNewWorkspaceFolderSourceOptionId,
  isNewWorkspaceProjectOptionQueryTooLarge,
  searchNewWorkspaceProjectOptions,
  type NewWorkspaceProjectOption
} from './new-workspace-project-options'
import type { Project, ProjectGroup, ProjectHostSetup, Repo } from '../../../shared/types'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/tmp/${id}`,
    displayName: id,
    badgeColor: '#111111',
    addedAt: 1,
    upstream: { owner: 'stablyai', repo: 'orca' },
    ...overrides
  }
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'github:stablyai/orca',
    displayName: 'orca',
    badgeColor: '#111111',
    providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' },
    sourceRepoIds: ['local-repo', 'ssh-repo'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function setup(overrides: Partial<ProjectHostSetup>): ProjectHostSetup {
  return {
    id: overrides.id ?? 'local-setup',
    projectId: overrides.projectId ?? 'github:stablyai/orca',
    hostId: overrides.hostId ?? 'local',
    repoId: overrides.repoId ?? 'local-repo',
    path: overrides.path ?? '/tmp/orca',
    displayName: overrides.displayName ?? 'orca',
    setupState: overrides.setupState ?? 'ready',
    setupMethod: overrides.setupMethod ?? 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function group(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/tmp/platform',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 1,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('buildNewWorkspaceProjectOptions', () => {
  it('deduplicates a logical project across local and SSH setups', () => {
    const options = buildNewWorkspaceProjectOptions({
      projects: [project()],
      projectHostSetups: [
        setup({ id: 'local-setup', hostId: 'local', repoId: 'local-repo' }),
        setup({ id: 'ssh-setup', hostId: 'ssh:builder', repoId: 'ssh-repo' })
      ],
      eligibleRepos: [repo('local-repo'), repo('ssh-repo', { connectionId: 'ssh:builder' })]
    })

    expect(options).toEqual([
      {
        id: 'github:stablyai/orca',
        kind: 'project',
        projectId: 'github:stablyai/orca',
        displayName: 'orca',
        badgeColor: '#111111',
        detail: 'stablyai/orca'
      }
    ])
  })

  it('excludes projects that do not have a ready eligible setup', () => {
    const options = buildNewWorkspaceProjectOptions({
      projects: [project(), project({ id: 'repo:other', displayName: 'other' })],
      projectHostSetups: [
        setup({ id: 'local-setup', repoId: 'local-repo' }),
        setup({
          id: 'other-setup',
          projectId: 'repo:other',
          repoId: 'other-repo',
          setupState: 'not-set-up'
        })
      ],
      eligibleRepos: [repo('local-repo'), repo('other-repo')]
    })

    expect(options.map((option) => option.id)).toEqual(['github:stablyai/orca'])
  })

  it('shows configured directories when project names are duplicated', () => {
    const options = buildNewWorkspaceProjectOptions({
      projects: [
        project({
          id: 'project:merchant-a',
          displayName: 'merchant',
          providerIdentity: undefined
        }),
        project({
          id: 'project:merchant-b',
          displayName: 'merchant',
          providerIdentity: undefined
        })
      ],
      projectHostSetups: [
        setup({
          id: 'merchant-a-setup',
          projectId: 'project:merchant-a',
          repoId: 'merchant-a-repo',
          path: '/workspace/storefront/merchant'
        }),
        setup({
          id: 'merchant-b-setup',
          projectId: 'project:merchant-b',
          repoId: 'merchant-b-repo',
          path: '/workspace/admin/merchant'
        })
      ],
      eligibleRepos: [repo('merchant-a-repo'), repo('merchant-b-repo')]
    })

    expect(options).toEqual([
      expect.objectContaining({
        id: 'project:merchant-b',
        detail: '/workspace/admin/merchant'
      }),
      expect.objectContaining({
        id: 'project:merchant-a',
        detail: '/workspace/storefront/merchant'
      })
    ])
  })

  it('keeps provider details when duplicate project names are already distinguishable', () => {
    const options = buildNewWorkspaceProjectOptions({
      projects: [
        project({
          id: 'github:acme/merchant',
          displayName: 'merchant',
          providerIdentity: { provider: 'github', owner: 'acme', repo: 'merchant' }
        }),
        project({
          id: 'github:contoso/merchant',
          displayName: 'merchant',
          providerIdentity: { provider: 'github', owner: 'contoso', repo: 'merchant' }
        })
      ],
      projectHostSetups: [
        setup({
          id: 'acme-setup',
          projectId: 'github:acme/merchant',
          repoId: 'acme-repo',
          path: '/workspace/acme/merchant'
        }),
        setup({
          id: 'contoso-setup',
          projectId: 'github:contoso/merchant',
          repoId: 'contoso-repo',
          path: '/workspace/contoso/merchant'
        })
      ],
      eligibleRepos: [repo('acme-repo'), repo('contoso-repo')]
    })

    expect(options.map((option) => option.detail).sort()).toEqual([
      'acme/merchant',
      'contoso/merchant'
    ])
  })

  it('shows directory details for non-provider duplicates with different setup counts', () => {
    const options = buildNewWorkspaceProjectOptions({
      projects: [
        project({
          id: 'project:merchant-single',
          displayName: 'merchant',
          providerIdentity: undefined
        }),
        project({
          id: 'project:merchant-multi',
          displayName: 'merchant',
          providerIdentity: undefined
        })
      ],
      projectHostSetups: [
        setup({
          id: 'merchant-single-setup',
          projectId: 'project:merchant-single',
          repoId: 'merchant-single-repo',
          path: '/workspace/single/merchant'
        }),
        setup({
          id: 'merchant-multi-local-setup',
          projectId: 'project:merchant-multi',
          repoId: 'merchant-multi-local-repo',
          path: '/workspace/multi/local/merchant'
        }),
        setup({
          id: 'merchant-multi-remote-setup',
          projectId: 'project:merchant-multi',
          hostId: 'ssh:builder',
          repoId: 'merchant-multi-remote-repo',
          path: '/workspace/multi/remote/merchant'
        })
      ],
      eligibleRepos: [
        repo('merchant-single-repo'),
        repo('merchant-multi-local-repo'),
        repo('merchant-multi-remote-repo')
      ]
    })

    expect(options.map((option) => option.detail).sort()).toEqual([
      '/workspace/multi/local/merchant (+1 more)',
      '/workspace/single/merchant'
    ])
  })

  it('keeps provider details while disambiguating non-provider duplicate names', () => {
    const options = buildNewWorkspaceProjectOptions({
      projects: [
        project({
          id: 'github:acme/merchant',
          displayName: 'merchant',
          providerIdentity: { provider: 'github', owner: 'acme', repo: 'merchant' }
        }),
        project({
          id: 'project:merchant-local',
          displayName: 'merchant',
          providerIdentity: undefined
        })
      ],
      projectHostSetups: [
        setup({
          id: 'acme-setup',
          projectId: 'github:acme/merchant',
          repoId: 'acme-repo',
          path: '/workspace/acme/merchant'
        }),
        setup({
          id: 'merchant-local-setup',
          projectId: 'project:merchant-local',
          repoId: 'merchant-local-repo',
          path: '/workspace/local/merchant'
        })
      ],
      eligibleRepos: [repo('acme-repo'), repo('merchant-local-repo')]
    })

    expect(options.map((option) => option.detail).sort()).toEqual([
      '/workspace/local/merchant',
      'acme/merchant'
    ])
  })

  it('adds host labels when duplicate project directory details collide', () => {
    const options = buildNewWorkspaceProjectOptions({
      projects: [
        project({
          id: 'project:merchant-local',
          displayName: 'merchant',
          providerIdentity: undefined
        }),
        project({
          id: 'project:merchant-remote',
          displayName: 'merchant',
          providerIdentity: undefined
        })
      ],
      projectHostSetups: [
        setup({
          id: 'merchant-local-setup',
          projectId: 'project:merchant-local',
          hostId: 'local',
          repoId: 'merchant-local-repo',
          path: '/workspace/merchant'
        }),
        setup({
          id: 'merchant-remote-setup',
          projectId: 'project:merchant-remote',
          hostId: 'ssh:builder',
          repoId: 'merchant-remote-repo',
          path: '/workspace/merchant'
        })
      ],
      eligibleRepos: [repo('merchant-local-repo'), repo('merchant-remote-repo')],
      hosts: [
        { id: 'local', label: 'Local Mac' },
        { id: 'ssh:builder', label: 'Builder' }
      ]
    })

    expect(options.map((option) => option.detail).sort()).toEqual([
      'Builder · /workspace/merchant',
      'Local Mac · /workspace/merchant'
    ])
  })

  it('adds host ids when duplicate project host labels still collide', () => {
    const options = buildNewWorkspaceProjectOptions({
      projects: [
        project({
          id: 'project:merchant-builder-a',
          displayName: 'merchant',
          providerIdentity: undefined
        }),
        project({
          id: 'project:merchant-builder-b',
          displayName: 'merchant',
          providerIdentity: undefined
        })
      ],
      projectHostSetups: [
        setup({
          id: 'merchant-builder-a-setup',
          projectId: 'project:merchant-builder-a',
          hostId: 'ssh:builder-a',
          repoId: 'merchant-builder-a-repo',
          path: '/workspace/merchant'
        }),
        setup({
          id: 'merchant-builder-b-setup',
          projectId: 'project:merchant-builder-b',
          hostId: 'ssh:builder-b',
          repoId: 'merchant-builder-b-repo',
          path: '/workspace/merchant'
        })
      ],
      eligibleRepos: [repo('merchant-builder-a-repo'), repo('merchant-builder-b-repo')],
      hosts: [
        { id: 'ssh:builder-a', label: 'Builder' },
        { id: 'ssh:builder-b', label: 'Builder' }
      ]
    })

    expect(options.map((option) => option.detail).sort()).toEqual([
      'Builder (ssh:builder-a) · /workspace/merchant',
      'Builder (ssh:builder-b) · /workspace/merchant'
    ])
  })

  it('filters project options by display name and detail', () => {
    const options: NewWorkspaceProjectOption[] = [
      {
        kind: 'project',
        id: 'orca',
        projectId: 'orca',
        displayName: 'Orca',
        badgeColor: '#111111',
        detail: 'stablyai/orca'
      },
      {
        kind: 'project',
        id: 'docs',
        projectId: 'docs',
        displayName: 'Docs',
        badgeColor: '#222222',
        detail: 'stablyai/docs'
      }
    ]

    expect(searchNewWorkspaceProjectOptions(options, 'docs')).toEqual([options[1]])
    expect(searchNewWorkspaceProjectOptions(options, 'stablyai/orca')).toEqual([options[0]])
  })

  it('rejects oversized pasted searches before reading project options', () => {
    const oversizedQuery = 'secret-project-option'.repeat(
      NEW_WORKSPACE_PROJECT_OPTION_QUERY_MAX_BYTES
    )
    const throwingOptions = [
      {
        id: 'secret',
        badgeColor: '#111111',
        get displayName(): string {
          throw new Error('oversized project option queries must not scan names')
        },
        get detail(): string {
          throw new Error('oversized project option queries must not scan details')
        }
      }
    ] as NewWorkspaceProjectOption[]

    expect(isNewWorkspaceProjectOptionQueryTooLarge(oversizedQuery)).toBe(true)
    expect(searchNewWorkspaceProjectOptions(throwingOptions, oversizedQuery)).toEqual([])
  })
})

describe('buildNewWorkspaceFolderSourceOptions', () => {
  it('keeps concrete source repos separate even when they are the same logical project', () => {
    const options = buildNewWorkspaceFolderSourceOptions([
      repo('local-repo', { displayName: 'orca', path: '/tmp/orca' }),
      repo('ssh-repo', {
        displayName: 'orca',
        path: '/srv/orca',
        connectionId: 'ssh:builder'
      })
    ])

    expect(options.map((option) => option.id).sort()).toEqual([
      'folder-source:local-repo',
      'folder-source:ssh-repo'
    ])
    expect(options.map((option) => option.detail).sort()).toEqual(['/srv/orca', '/tmp/orca'])
    expect(getRepoIdFromNewWorkspaceFolderSourceOptionId('folder-source:ssh-repo')).toBe('ssh-repo')
  })
})

describe('buildNewWorkspaceCreateTargetOptions', () => {
  it('includes folder-backed repo groups and excludes organizational groups', async () => {
    const { buildNewWorkspaceCreateTargetOptions } = await import('./new-workspace-project-options')
    const options = buildNewWorkspaceCreateTargetOptions({
      projects: [project()],
      projectHostSetups: [setup({ id: 'local-setup', repoId: 'local-repo' })],
      eligibleRepos: [repo('local-repo')],
      projectGroups: [
        group({ id: 'folder-group', name: 'Platform', parentPath: '/tmp/platform' }),
        group({ id: 'org-group', name: 'Org', parentPath: null })
      ]
    })

    expect(options.map((option) => option.id).sort()).toEqual([
      'github:stablyai/orca',
      'project-group:folder-group'
    ])
    expect(options.find((option) => option.id === 'project-group:folder-group')).toMatchObject({
      kind: 'project-group',
      projectGroupId: 'folder-group',
      displayName: 'Platform',
      detail: '/tmp/platform'
    })
  })
})
