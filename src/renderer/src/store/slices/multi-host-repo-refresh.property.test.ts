import { describe, expect, it } from 'vitest'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup, Repo } from '../../../../shared/types'
import {
  mergeProjectHostSetupCompatibility,
  projectCompatibilityFromRepos
} from './project-host-setup-compatibility-merge'
import { mergeFetchedReposForHost } from './repo-host-refresh-merge'

const HOSTS = [
  'local',
  'runtime:env-a',
  'runtime:env-b'
] as const satisfies readonly ExecutionHostId[]
const PROJECT_ID = 'github:stablyai/orca'

type HostId = (typeof HOSTS)[number]
type TruthByHost = Record<HostId, Repo[]>

function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T
}

function repo(hostId: HostId, index: number, revision = 0): Repo {
  const hostSlug = hostId.replace(/[^a-z0-9]+/gi, '-')
  const id = `${hostSlug}-repo-${index}`
  return {
    id,
    path: `/${hostSlug}/orca-${index}`,
    displayName: revision > 0 ? `orca ${index}.${revision}` : `orca ${index}`,
    badgeColor: '#000000',
    addedAt: index,
    executionHostId: hostId,
    upstream: { owner: 'stablyai', repo: 'orca' }
  }
}

function cloneRepos(repos: readonly Repo[]): Repo[] {
  return repos.map((entry) => ({
    ...entry,
    upstream: entry.upstream ? { ...entry.upstream } : null
  }))
}

function setupKey(setup: ProjectHostSetup): string {
  return `${setup.hostId}:${setup.repoId}`
}

function repoKeys(repos: readonly Repo[]): string[] {
  return repos.map((entry) => `${getRepoExecutionHostId(entry)}:${entry.id}`).sort()
}

function assertStateMatchesTruth(repos: readonly Repo[], truthByHost: TruthByHost): void {
  for (const hostId of HOSTS) {
    expect(
      repos
        .filter((entry) => getRepoExecutionHostId(entry) === hostId)
        .map((entry) => `${entry.id}:${entry.displayName}`)
        .sort()
    ).toEqual(truthByHost[hostId].map((entry) => `${entry.id}:${entry.displayName}`).sort())
  }
}

function assertCompatibilityMatchesRepos(repos: readonly Repo[]): void {
  const compatibility = mergeProjectHostSetupCompatibility(
    projectCompatibilityFromRepos(repos),
    projectHostSetupProjectionFromRepos(
      repos.filter((entry) => getRepoExecutionHostId(entry) !== 'local')
    )
  )
  const setups = compatibility.projectHostSetups.map(setupKey).sort()
  expect(setups).toEqual(repoKeys(repos))
  expect(
    compatibility.projects.find((project) => project.id === PROJECT_ID)?.sourceRepoIds.sort()
  ).toEqual(repos.map((entry) => entry.id).sort())
}

function applyGeneratedHostOperation(
  truthByHost: TruthByHost,
  random: () => number,
  nextIndexByHost: Record<HostId, number>
): HostId {
  const hostId = pick(random, HOSTS)
  const repos = truthByHost[hostId]
  const action = pick(random, ['add', 'remove', 'rename', 'reorder'] as const)
  switch (action) {
    case 'add': {
      const index = nextIndexByHost[hostId]
      nextIndexByHost[hostId] += 1
      repos.push(repo(hostId, index))
      break
    }
    case 'remove':
      if (repos.length > 1) {
        repos.splice(Math.floor(random() * repos.length), 1)
      }
      break
    case 'rename': {
      const index = Math.floor(random() * repos.length)
      const current = repos[index]
      repos[index] = { ...current, displayName: `${current.displayName}*` }
      break
    }
    case 'reorder':
      repos.reverse()
      break
  }
  return hostId
}

describe('multi-host repo refresh properties', () => {
  it('preserves every host partition across generated refresh sequences', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const random = createRandom(seed)
      const truthByHost: TruthByHost = {
        local: [repo('local', 1)],
        'runtime:env-a': [repo('runtime:env-a', 1)],
        'runtime:env-b': [repo('runtime:env-b', 1)]
      }
      const nextIndexByHost: Record<HostId, number> = {
        local: 2,
        'runtime:env-a': 2,
        'runtime:env-b': 2
      }
      let repos: Repo[] = []
      for (const hostId of HOSTS) {
        repos = mergeFetchedReposForHost(repos, cloneRepos(truthByHost[hostId]), hostId)
      }

      for (let step = 0; step < 50; step += 1) {
        const hostId = applyGeneratedHostOperation(truthByHost, random, nextIndexByHost)
        repos = mergeFetchedReposForHost(repos, cloneRepos(truthByHost[hostId]), hostId)

        assertStateMatchesTruth(repos, truthByHost)
        assertCompatibilityMatchesRepos(repos)
      }
    }
  })
})
