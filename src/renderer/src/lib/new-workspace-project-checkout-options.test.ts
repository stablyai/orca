import { describe, expect, it } from 'vitest'
import {
  buildNewWorkspaceProjectOptions,
  getProjectRowHostSetups,
  getSelectedNewWorkspaceProjectOptionId
} from './new-workspace-project-options'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'

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

const project: Project = {
  id: 'github:stablyai/orca',
  displayName: 'orca',
  badgeColor: '#111111',
  providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' },
  sourceRepoIds: [],
  createdAt: 1,
  updatedAt: 1
}

function setup(
  overrides: Pick<ProjectHostSetup, 'id' | 'repoId'> & Partial<ProjectHostSetup>
): ProjectHostSetup {
  return {
    projectId: project.id,
    hostId: 'local',
    path: `/code/${overrides.repoId}`,
    displayName: overrides.repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('new-workspace project checkout rows', () => {
  it('lists each same-host checkout and keeps the project row for its other hosts', () => {
    const projectHostSetups = [
      setup({ id: 'main-setup', repoId: 'main', path: '/code/orca' }),
      setup({ id: 'review-setup', repoId: 'review', path: '/code/orca-review' }),
      setup({ id: 'ssh-setup', hostId: 'ssh:builder', repoId: 'ssh-repo' })
    ]
    const options = buildNewWorkspaceProjectOptions({
      projects: [project],
      projectHostSetups,
      eligibleRepos: [
        repo('main', { displayName: 'orca' }),
        repo('review', { displayName: 'orca-review' }),
        repo('ssh-repo', { connectionId: 'builder' })
      ]
    })

    expect(options.map((option) => [option.displayName, option.detail])).toEqual([
      ['orca', '/code/orca'],
      ['orca', 'stablyai/orca'],
      ['orca-review', '/code/orca-review']
    ])
    expect(getProjectRowHostSetups(options, projectHostSetups).map((entry) => entry.id)).toEqual([
      'ssh-setup'
    ])
    expect(
      getSelectedNewWorkspaceProjectOptionId(options, project.id, 'review-setup', 'local')
    ).toBe(options[2].id)
    expect(
      getSelectedNewWorkspaceProjectOptionId(options, project.id, 'ssh-setup', 'ssh:builder')
    ).toBe(project.id)
  })

  it('names the host on a remote checkout so it does not read as the local one', () => {
    // Same repo names, paths and setup ids on both machines; without the host the rows are identical.
    const projectHostSetups = [
      setup({ id: 'a', repoId: 'local-a', path: '/code/orca' }),
      setup({ id: 'b', repoId: 'local-b', path: '/code/orca-b' }),
      setup({ id: 'a', hostId: 'ssh:builder', repoId: 'ssh-a', path: '/code/orca' }),
      setup({ id: 'b', hostId: 'ssh:builder', repoId: 'ssh-b', path: '/code/orca-b' })
    ]
    const options = buildNewWorkspaceProjectOptions({
      projects: [project],
      projectHostSetups,
      eligibleRepos: [
        repo('local-a', { displayName: 'orca' }),
        repo('local-b', { displayName: 'orca-b' }),
        repo('ssh-a', { displayName: 'orca', connectionId: 'builder' }),
        repo('ssh-b', { displayName: 'orca-b', connectionId: 'builder' })
      ],
      hosts: [
        { id: 'local', label: 'This Mac' },
        { id: 'ssh:builder', label: 'Builder' }
      ]
    })

    expect(options.map((option) => [option.displayName, option.detail])).toEqual([
      ['orca', '/code/orca'],
      ['orca', 'Builder · /code/orca'],
      ['orca-b', '/code/orca-b'],
      ['orca-b', 'Builder · /code/orca-b']
    ])
    expect(new Set(options.map((option) => option.id)).size).toBe(4)
    expect(getSelectedNewWorkspaceProjectOptionId(options, project.id, 'a', 'ssh:builder')).toBe(
      options[1].id
    )
  })
})
