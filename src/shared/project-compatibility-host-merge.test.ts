import { describe, expect, it } from 'vitest'
import type { ProjectCatalogRows } from './project-compatibility-merge'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import { mergeFetchedHostProjectCatalog } from './project-compatibility-host-merge'

const REMOTE = 'runtime:devbox'

function repo(id: string, hostId: string, path: string): Repo {
  return {
    id,
    path,
    displayName: 'myapp',
    kind: 'git',
    connectionId: null,
    executionHostId: hostId
  } as unknown as Repo
}

function setup(id: string, repoId: string, hostId: string, path: string): ProjectHostSetup {
  return {
    id,
    projectId: 'github:acme/myapp',
    hostId,
    repoId,
    path,
    displayName: 'myapp',
    kind: 'git',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1
  } as unknown as ProjectHostSetup
}

const project: Project = {
  id: 'github:acme/myapp',
  displayName: 'myapp',
  badgeColor: '#888888',
  sourceRepoIds: ['repo-local', 'repo-remote'],
  createdAt: 1,
  updatedAt: 1
} as unknown as Project

const repos = [
  repo('repo-local', 'local', '/Users/me/src/myapp'),
  repo('repo-remote', REMOTE, '/home/me/myapp')
]

describe('mergeFetchedHostProjectCatalog setup order', () => {
  it('keeps the previous host order when a host catalog refreshes', () => {
    let state: ProjectCatalogRows = { projects: [project], projectHostSetups: [] }
    state = mergeFetchedHostProjectCatalog({
      previous: state,
      fetched: {
        projects: [project],
        setups: [setup('s-l', 'repo-local', 'local', '/Users/me/src/myapp')]
      },
      repos,
      hostId: 'local'
    })
    state = mergeFetchedHostProjectCatalog({
      previous: state,
      fetched: {
        projects: [project],
        setups: [setup('s-r', 'repo-remote', REMOTE, '/home/me/myapp')]
      },
      repos,
      hostId: REMOTE
    })
    expect(state.projectHostSetups.map((entry) => entry.hostId)).toEqual(['local', REMOTE])

    const refreshed = mergeFetchedHostProjectCatalog({
      previous: state,
      fetched: {
        projects: [project],
        setups: [setup('s-l', 'repo-local', 'local', '/Users/me/src/myapp-updated')]
      },
      repos,
      hostId: 'local'
    })
    expect(refreshed.projectHostSetups.map((entry) => entry.hostId)).toEqual(['local', REMOTE])
    expect(refreshed.projectHostSetups[0].path).toBe('/Users/me/src/myapp-updated')
  })
})
