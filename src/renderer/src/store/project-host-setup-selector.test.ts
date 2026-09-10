import { describe, expect, it } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { getProjectHostSetupProjectionFromState } from './project-host-setup-selector'

type CollectionCounters = {
  map: number
  flatMap: number
  iterator: number
  length: number
}

function countCollectionReads<T>(items: readonly T[]): {
  value: readonly T[]
  counters: CollectionCounters
} {
  const target = [...items]
  const counters: CollectionCounters = { map: 0, flatMap: 0, iterator: 0, length: 0 }
  const value = new Proxy(target, {
    get(array, property) {
      if (property === 'map' || property === 'flatMap') {
        counters[property] += 1
        const method = Reflect.get(array, property) as (...args: unknown[]) => unknown
        return method.bind(array)
      }
      if (property === Symbol.iterator) {
        counters.iterator += 1
        return array[Symbol.iterator].bind(array)
      }
      if (property === 'length') {
        counters.length += 1
      }
      return Reflect.get(array, property)
    }
  })
  return { value, counters }
}

function makeRepo(id: string): Repo {
  return {
    id,
    path: `/repo/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git'
  }
}

function makeProject(id: string, repoId: string): Project {
  return {
    id,
    displayName: id,
    badgeColor: '#737373',
    sourceRepoIds: [repoId],
    createdAt: 1,
    updatedAt: 1
  }
}

function makeSetup(repoId: string, projectId: string): ProjectHostSetup {
  return {
    id: repoId,
    projectId,
    hostId: 'local',
    repoId,
    path: `/repo/${repoId}`,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('project host setup selector', () => {
  it('does not rescan stable catalog collections across 1,000 reads', () => {
    const repos = Array.from({ length: 100 }, (_, index) => makeRepo(`repo-${index}`))
    const projects = repos.map((repo) => makeProject(`repo:${repo.id}`, repo.id))
    const setups = repos.map((repo) => makeSetup(repo.id, `repo:${repo.id}`))
    const countedRepos = countCollectionReads(repos)
    const countedProjects = countCollectionReads(projects)
    const countedSetups = countCollectionReads(setups)
    const state = {
      repos: countedRepos.value,
      projects: countedProjects.value,
      projectHostSetups: countedSetups.value
    }

    const first = getProjectHostSetupProjectionFromState(state)
    expect(countedRepos.counters.map).toBeGreaterThan(0)
    expect(countedRepos.counters.iterator).toBeGreaterThan(0)
    expect(countedProjects.counters.flatMap).toBeGreaterThan(0)
    expect(countedSetups.counters.map).toBeGreaterThan(0)
    countedRepos.counters.map = 0
    countedRepos.counters.flatMap = 0
    countedRepos.counters.iterator = 0
    countedRepos.counters.length = 0
    countedProjects.counters.map = 0
    countedProjects.counters.flatMap = 0
    countedProjects.counters.iterator = 0
    countedProjects.counters.length = 0
    countedSetups.counters.map = 0
    countedSetups.counters.flatMap = 0
    countedSetups.counters.iterator = 0
    countedSetups.counters.length = 0

    for (let read = 0; read < 1_000; read += 1) {
      expect(getProjectHostSetupProjectionFromState(state)).toBe(first)
    }

    expect(countedRepos.counters).toEqual({ map: 0, flatMap: 0, iterator: 0, length: 0 })
    expect(countedProjects.counters).toEqual({ map: 0, flatMap: 0, iterator: 0, length: 0 })
    expect(countedSetups.counters).toEqual({ map: 0, flatMap: 0, iterator: 0, length: 0 })
  })

  it('invalidates the projection when hydrated setup identity changes', () => {
    const repo = makeRepo('repo-1')
    const repos = [repo]
    const projects = [makeProject('repo:repo-1', repo.id)]
    const setups = [makeSetup(repo.id, 'repo:repo-1')]
    const first = getProjectHostSetupProjectionFromState({
      repos,
      projects,
      projectHostSetups: setups
    })
    const replacementSetups = [...setups]

    const next = getProjectHostSetupProjectionFromState({
      repos,
      projects,
      projectHostSetups: replacementSetups
    })

    expect(next).not.toBe(first)
    expect(next.projects).toBe(projects)
    expect(next.setups).toBe(replacementSetups)
  })

  it('invalidates the projection when the repo identity changes', () => {
    const repo = makeRepo('repo-1')
    const repos = [repo]
    const projects = [makeProject('repo:repo-1', repo.id)]
    const setups = [makeSetup(repo.id, 'repo:repo-1')]
    getProjectHostSetupProjectionFromState({ repos, projects, projectHostSetups: setups })

    const replacementRepos = [makeRepo('repo-2')]
    const next = getProjectHostSetupProjectionFromState({
      repos: replacementRepos,
      projects,
      projectHostSetups: setups
    })

    expect(next.projects.map((project) => project.id)).toContain('repo:repo-2')
    expect(next.setups.map((setup) => setup.id)).toContain('repo-2')
  })
})
