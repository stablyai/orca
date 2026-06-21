import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectHostSetup, Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const PROJECT_ID = 'github:stablyai/orca'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/Users/alice/orca',
  displayName: 'orca',
  badgeColor: '#000000',
  addedAt: 1,
  upstream: { owner: 'stablyai', repo: 'orca' }
}

const runtimeRepo: Repo = {
  id: 'runtime-repo',
  path: '/srv/orca',
  displayName: 'orca',
  badgeColor: '#111111',
  addedAt: 2,
  upstream: { owner: 'stablyai', repo: 'orca' }
}

function project(sourceRepoIds: string[]): Project {
  return {
    id: PROJECT_ID,
    displayName: 'orca',
    badgeColor: '#000000',
    sourceRepoIds,
    providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' },
    createdAt: 1,
    updatedAt: 1
  }
}

function setup(hostId: 'local' | `runtime:${string}`, repoId: string): ProjectHostSetup {
  return {
    id: repoId,
    projectId: PROJECT_ID,
    hostId,
    repoId,
    path: repoId === localRepo.id ? localRepo.path : runtimeRepo.path,
    displayName: 'orca',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}

const reposList = vi.fn()
const projectsList = vi.fn()
const projectsListHostSetups = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset()
  projectsList.mockReset()
  projectsListHostSetups.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: {
        list: reposList
      },
      projects: {
        list: projectsList,
        listHostSetups: projectsListHostSetups
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice multi-host refresh', () => {
  it('keeps local and runtime checkouts for the same project after switching hosts', async () => {
    reposList.mockResolvedValue([localRepo])
    projectsList.mockResolvedValue([project([localRepo.id])])
    projectsListHostSetups.mockResolvedValue([setup('local', localRepo.id)])
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'repo.list') {
        return Promise.resolve({
          id: 'repo-list',
          ok: true,
          result: { repos: [runtimeRepo] },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      if (method === 'project.list') {
        return Promise.resolve({
          id: 'project-list',
          ok: true,
          result: { projects: [project([runtimeRepo.id])] },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      if (method === 'projectHostSetup.list') {
        return Promise.resolve({
          id: 'setup-list',
          ok: true,
          result: { setups: [setup('runtime:env-1', runtimeRepo.id)] },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      throw new Error(`Unexpected runtime method: ${method}`)
    })
    const store = createTestStore()

    await store.getState().fetchRepos()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })
    await store.getState().fetchRepos()

    expect(store.getState().repos).toEqual([
      expect.objectContaining({ id: localRepo.id, executionHostId: 'local' }),
      expect.objectContaining({ id: runtimeRepo.id, executionHostId: 'runtime:env-1' })
    ])
    expect(store.getState().projects).toEqual([
      expect.objectContaining({
        id: PROJECT_ID,
        sourceRepoIds: [localRepo.id, runtimeRepo.id]
      })
    ])
    expect(store.getState().projectHostSetups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostId: 'local', repoId: localRepo.id }),
        expect.objectContaining({ hostId: 'runtime:env-1', repoId: runtimeRepo.id })
      ])
    )
  })
})
