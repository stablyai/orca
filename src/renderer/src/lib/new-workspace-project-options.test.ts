import { describe, expect, it } from 'vitest'
import {
  buildNewWorkspaceFolderSourceOptions,
  buildNewWorkspaceProjectOptions,
  getRepoIdFromNewWorkspaceFolderSourceOptionId
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
