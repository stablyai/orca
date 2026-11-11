import { describe, expect, it } from 'vitest'
import {
  buildNewWorkspaceProjectOptions,
  getProjectRowHostSetups,
  getSelectedNewWorkspaceProjectOptionId
} from './workspace/creation/new-workspace-project-options'
import { buildProjectGroupingIndex } from '../../../shared/project-section-grouping'
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
    displayName: overrides.repoId
      .replace(/^local-|^ssh-/, '')
      .replace(/^a$/, 'orca')
      .replace(/^b$/, 'orca-b'),
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('new-workspace project checkout rows', () => {
  it('offers a physical group when only its alias registration is eligible', () => {
    const options = buildNewWorkspaceProjectOptions({
      projects: [project, { ...project, id: 'repo:alias' }],
      projectHostSetups: [
        setup({ id: 'canonical', repoId: 'canonical', path: '/app' }),
        setup({ id: 'alias', repoId: 'alias', projectId: 'repo:alias', path: '/app' })
      ],
      eligibleRepos: [repo('alias')]
    })
    expect(options.map((option) => option.id)).toEqual(['project:github:stablyai/orca'])
  })

  it.each(['repository', 'host', 'folder'] as const)(
    'uses %s grouping while retaining exact checkout selection',
    (mode) => {
      const projectHostSetups = [
        setup({ id: 'main-setup', repoId: 'main', path: '/code/orca', displayName: 'orca' }),
        setup({
          id: 'review-setup',
          repoId: 'review',
          path: '/code/orca-review',
          displayName: 'orca-review'
        }),
        setup({ id: 'ssh-setup', hostId: 'ssh:builder', repoId: 'ssh-repo' })
      ]
      const options = buildNewWorkspaceProjectOptions({
        settings: { projectGroupingMode: mode },
        projects: [project],
        projectHostSetups,
        eligibleRepos: [
          repo('main', { displayName: 'orca' }),
          repo('review', { displayName: 'orca-review' }),
          repo('ssh-repo', { connectionId: 'builder' })
        ]
      })

      expect(options).toHaveLength(mode === 'repository' ? 1 : mode === 'host' ? 2 : 3)
      const selectedGroup = buildProjectGroupingIndex({
        projects: [project],
        projectHostSetups,
        settings: { projectGroupingMode: mode }
      }).groupByRepoHost.get('local\0review')
      expect(
        getSelectedNewWorkspaceProjectOptionId(
          options,
          selectedGroup?.key ?? null,
          'review-setup',
          'local'
        )
      ).toBe(selectedGroup?.key)
      expect(options.find((option) => option.id === selectedGroup?.key)).toMatchObject(
        mode === 'folder'
          ? { checkout: { projectHostSetupId: 'review-setup', hostId: 'local', repoId: 'review' } }
          : { displayName: 'orca' }
      )
      expect(getProjectRowHostSetups(options, projectHostSetups).map((entry) => entry.id)).toEqual(
        mode === 'repository'
          ? ['main-setup', 'review-setup', 'ssh-setup']
          : mode === 'host'
            ? ['main-setup', 'review-setup']
            : []
      )
    }
  )

  it('names the host on a remote checkout so it does not read as the local one', () => {
    // Same repo names, paths and setup ids on both machines; without the host the rows are identical.
    const projectHostSetups = [
      setup({ id: 'a', repoId: 'local-a', path: '/code/orca' }),
      setup({ id: 'b', repoId: 'local-b', path: '/code/orca-b' }),
      setup({ id: 'a', hostId: 'ssh:builder', repoId: 'ssh-a', path: '/code/orca' }),
      setup({ id: 'b', hostId: 'ssh:builder', repoId: 'ssh-b', path: '/code/orca-b' })
    ]
    const options = buildNewWorkspaceProjectOptions({
      settings: { projectGroupingMode: 'folder' },
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
      ['orca', 'Builder · /code/orca'],
      ['orca', 'This Mac · /code/orca'],
      ['orca-b', 'Builder · /code/orca-b'],
      ['orca-b', 'This Mac · /code/orca-b']
    ])
    expect(new Set(options.map((option) => option.id)).size).toBe(4)
    expect(getSelectedNewWorkspaceProjectOptionId(options, project.id, 'a', 'ssh:builder')).toBe(
      options[0].id
    )
  })
})
