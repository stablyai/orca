import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const localRepo: Repo = {
  id: 'same-repo',
  path: '/Users/alice/orca',
  displayName: 'local orca',
  badgeColor: '#000000',
  addedAt: 1
}

const runtimeRepo: Repo = {
  id: 'same-repo',
  path: '/srv/orca',
  displayName: 'remote orca',
  badgeColor: '#111111',
  addedAt: 2
}

const reposList = vi.fn()
const reposUpdate = vi.fn()
const projectsList = vi.fn()
const projectsListHostSetups = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset()
  reposUpdate.mockReset()
  projectsList.mockReset()
  projectsListHostSetups.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  projectsList.mockResolvedValue([])
  projectsListHostSetups.mockResolvedValue([])
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: {
        list: reposList,
        update: reposUpdate
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
  it('keeps same-id local and runtime repos after switching hosts', async () => {
    reposList.mockResolvedValue([localRepo])
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
          result: { projects: [] },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      if (method === 'projectHostSetup.list') {
        return Promise.resolve({
          id: 'setup-list',
          ok: true,
          result: { setups: [] },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      throw new Error(`Unexpected runtime method: ${method}`)
    })
    const store = createTestStore()

    await store.getState().fetchRepos()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })
    await store.getState().fetchRepos()

    expect(store.getState().repos).toHaveLength(2)
    expect(store.getState().repos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: localRepo.id,
          path: localRepo.path,
          executionHostId: 'local'
        }),
        expect.objectContaining({
          id: runtimeRepo.id,
          path: runtimeRepo.path,
          executionHostId: 'runtime:env-1'
        })
      ])
    )
  })

  it('updates only the active host repo when ids collide across hosts', async () => {
    reposList.mockResolvedValue([localRepo])
    runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) => {
      const { method } = request
      if (method === 'repo.list') {
        return Promise.resolve({
          id: 'repo-list',
          ok: true,
          result: { repos: [runtimeRepo] },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      if (method === 'repo.update') {
        const updates = (request as unknown as { params: { updates: Partial<Repo> } }).params
          .updates
        return Promise.resolve({
          id: 'repo-update',
          ok: true,
          result: { repo: { ...runtimeRepo, ...updates } },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      if (method === 'project.list') {
        return Promise.resolve({
          id: 'project-list',
          ok: true,
          result: { projects: [] },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      if (method === 'projectHostSetup.list') {
        return Promise.resolve({
          id: 'setup-list',
          ok: true,
          result: { setups: [] },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      throw new Error(`Unexpected runtime method: ${method}`)
    })
    const store = createTestStore()

    await store.getState().fetchRepos()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })
    await store.getState().fetchRepos()
    const updated = await store.getState().updateRepo(runtimeRepo.id, {
      displayName: 'remote renamed'
    })

    expect(updated).toBe(true)
    expect(reposUpdate).not.toHaveBeenCalled()
    expect(store.getState().repos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: localRepo.id,
          displayName: localRepo.displayName,
          executionHostId: 'local'
        }),
        expect.objectContaining({
          id: runtimeRepo.id,
          displayName: 'remote renamed',
          executionHostId: 'runtime:env-1'
        })
      ])
    )
  })
})
