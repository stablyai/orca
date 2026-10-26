import { describe, expect, it } from 'vitest'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import { mergeFetchedProjectCompatibilityForHost } from './project-compatibility-host-merge'
import {
  getReposById,
  mergePreviousProjectMetadata,
  mergeUpdatedProjectCompatibilityProject
} from './project-compatibility-merge'

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project',
    displayName: 'Project',
    badgeColor: '#737373',
    sourceRepoIds: ['r1'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'r1',
    path: '/repo',
    displayName: 'Project',
    badgeColor: '#737373',
    addedAt: 1,
    ...overrides
  }
}

function setup(hostId: ProjectHostSetup['hostId']): ProjectHostSetup {
  return {
    id: hostId,
    projectId: 'project',
    hostId,
    repoId: hostId,
    path: '/repo',
    displayName: 'Project',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('project prompt template catalog refresh', () => {
  it('retains canonical changes through another host refresh and applies owner resets', () => {
    const local = setup('local')
    const remote = setup('runtime:remote')
    const previous = {
      projects: [project({ linkedWorkItemPromptTemplate: '{{url}} /saved' })],
      projectHostSetups: [local, remote]
    }
    const refreshed = mergeFetchedProjectCompatibilityForHost({
      previous,
      fetched: { projects: [project()], projectHostSetups: [remote] },
      repos: [],
      hostId: 'runtime:remote'
    })
    expect(refreshed.projects[0]?.linkedWorkItemPromptTemplate).toBe('{{url}} /saved')
    const reset = mergeFetchedProjectCompatibilityForHost({
      previous: refreshed,
      fetched: { projects: [project()], projectHostSetups: [local] },
      repos: [],
      hostId: 'local'
    })
    expect(reset.projects[0]?.linkedWorkItemPromptTemplate).toBeUndefined()
  })

  it('applies local catalog resets for SSH-only projects', () => {
    const ssh = setup('ssh:host')
    const result = mergeFetchedProjectCompatibilityForHost({
      previous: {
        projects: [project({ linkedWorkItemPromptTemplate: '{{url}} /saved' })],
        projectHostSetups: [ssh]
      },
      fetched: { projects: [project()], projectHostSetups: [ssh] },
      repos: [],
      hostId: 'local'
    })
    expect(result.projects[0]?.linkedWorkItemPromptTemplate).toBeUndefined()
  })

  it('preserves the local catalog template when only SSH setups remain visible', () => {
    const previous = project({ linkedWorkItemPromptTemplate: '{{url}} /local' })
    expect(
      mergePreviousProjectMetadata(
        previous,
        project({ linkedWorkItemPromptTemplate: '{{url}} /remote' }),
        new Map(),
        'runtime:remote',
        [setup('ssh:host'), setup('runtime:remote')]
      ).linkedWorkItemPromptTemplate
    ).toBe('{{url}} /local')
    expect(
      mergePreviousProjectMetadata(previous, project(), new Map(), 'local', [setup('ssh:host')])
        .linkedWorkItemPromptTemplate
    ).toBeUndefined()
  })

  it('uses the same stable remote owner irrespective of refresh order', () => {
    const previous = project({ linkedWorkItemPromptTemplate: '{{url}} /owner' })
    const setups = [setup('runtime:z'), setup('runtime:a')]
    expect(
      mergePreviousProjectMetadata(previous, project(), new Map(), 'runtime:z', setups)
        .linkedWorkItemPromptTemplate
    ).toBe('{{url}} /owner')
    expect(
      mergePreviousProjectMetadata(previous, project(), new Map(), 'runtime:a', setups)
        .linkedWorkItemPromptTemplate
    ).toBeUndefined()
  })

  it('retains the template when a refresh has no ownership evidence', () => {
    const previous = project({ linkedWorkItemPromptTemplate: '{{url}} /owner' })
    expect(
      mergePreviousProjectMetadata(previous, project(), new Map(), 'runtime:a')
        .linkedWorkItemPromptTemplate
    ).toBe('{{url}} /owner')
  })

  it('clears missing templates on local and remote-only owner refreshes', () => {
    const previous = project({ linkedWorkItemPromptTemplate: '{url} /engineer' })
    for (const hostId of ['local', 'runtime:remote']) {
      const repos = getReposById([
        repo(hostId === 'local' ? {} : { executionHostId: 'runtime:remote' })
      ])
      expect(
        mergePreviousProjectMetadata(previous, project(), repos, hostId)
          .linkedWorkItemPromptTemplate
      ).toBeUndefined()
    }
  })

  it('preserves local configuration while an unrelated runtime refreshes the same project', () => {
    const repos = getReposById([repo(), repo({ id: 'remote', executionHostId: 'runtime:remote' })])
    for (const template of [undefined, '{url} /local']) {
      const previous = project({
        sourceRepoIds: ['r1', 'remote'],
        linkedWorkItemPromptTemplate: template
      })
      const current = project({
        sourceRepoIds: ['remote'],
        linkedWorkItemPromptTemplate: '{url} /remote'
      })
      expect(
        mergePreviousProjectMetadata(previous, current, repos, 'runtime:remote')
          .linkedWorkItemPromptTemplate
      ).toBe(template)
    }
  })

  it('uses only the applied host response when merging a template update or reset', () => {
    const previous = project({ linkedWorkItemPromptTemplate: '{url} /old' })
    const result = mergeUpdatedProjectCompatibilityProject(previous, project(), {
      linkedWorkItemPromptTemplate: '{url} /ignored'
    })
    expect(result.linkedWorkItemPromptTemplate).toBeUndefined()
    expect(
      mergeUpdatedProjectCompatibilityProject(previous, project(), {
        linkedWorkItemPromptTemplate: null
      }).linkedWorkItemPromptTemplate
    ).toBeUndefined()
  })
})
