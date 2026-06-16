import { describe, expect, it } from 'vitest'
import { buildNewWorkspaceProjectOptions } from './new-workspace-project-options'
import type { Project, ProjectHostSetup, Repo } from '../../../shared/types'

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
