import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2
}

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Flute',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const projectGroupsCreate = vi.fn()
const projectGroupsMoveProject = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      projectGroups: {
        create: projectGroupsCreate,
        moveProject: projectGroupsMoveProject
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('paired runtime project group routing', () => {
  it('creates and groups a paired runtime repo through its owner instead of the active host', async () => {
    runtimeEnvironmentCall.mockImplementation(async ({ method }) => ({
      id: `rpc-${method}`,
      ok: true,
      result:
        method === 'projectGroup.create'
          ? { group: projectGroup }
          : { repo: { ...remoteRepo, projectGroupId: projectGroup.id } },
      _meta: { runtimeId: 'runtime-remote' }
    }))
    projectGroupsCreate.mockRejectedValue(
      new Error('The client catalog does not own paired project groups')
    )
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-2' } as never,
      repos: [{ ...remoteRepo, executionHostId: 'runtime:env-1' }]
    })

    const group = await store.getState().createProjectGroup('Flute', { hostId: 'runtime:env-1' })

    expect(group).toEqual({ ...projectGroup, executionHostId: 'runtime:env-1' })
    await expect(
      store.getState().moveProjectToGroup(remoteRepo.id, group!.id, undefined, {
        hostId: 'runtime:env-1'
      })
    ).resolves.toBe(true)
    expect(store.getState().repos).toEqual([
      {
        ...remoteRepo,
        projectGroupId: projectGroup.id,
        executionHostId: 'runtime:env-1'
      }
    ])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'projectGroup.create' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-1', method: 'projectGroup.moveProject' })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-2' })
    )
  })

  it('keeps a confirmed runtime group when an older catalog fetch finishes later', async () => {
    let resolveStaleList!: (value: unknown) => void
    runtimeEnvironmentCall.mockImplementation(({ method }) => {
      if (method === 'projectGroup.list') {
        return new Promise((resolve) => {
          resolveStaleList = resolve
        })
      }
      if (method === 'projectGroup.create') {
        return Promise.resolve({
          id: 'rpc-create',
          ok: true,
          result: { group: projectGroup },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const store = createTestStore()

    const staleFetch = store.getState().fetchProjectGroups({ runtimeEnvironmentId: 'env-1' })
    await vi.waitFor(() => expect(resolveStaleList).toBeTypeOf('function'))

    await expect(
      store.getState().createProjectGroup('Flute', { hostId: 'runtime:env-1' })
    ).resolves.toEqual({ ...projectGroup, executionHostId: 'runtime:env-1' })

    resolveStaleList({
      id: 'rpc-stale-list',
      ok: true,
      result: { groups: [] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await staleFetch

    expect(store.getState().projectGroups).toEqual([
      { ...projectGroup, executionHostId: 'runtime:env-1' }
    ])
  })

  it('does not duplicate a created group already published by a catalog refresh', async () => {
    let resolveCreate!: (value: unknown) => void
    runtimeEnvironmentCall.mockImplementation(({ method }) => {
      if (method === 'projectGroup.create') {
        return new Promise((resolve) => {
          resolveCreate = resolve
        })
      }
      if (method === 'projectGroup.list') {
        return Promise.resolve({
          id: 'rpc-list',
          ok: true,
          result: { groups: [projectGroup] },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const store = createTestStore()

    const pendingCreate = store.getState().createProjectGroup('Flute', { hostId: 'runtime:env-1' })
    await vi.waitFor(() => expect(resolveCreate).toBeTypeOf('function'))

    await store.getState().fetchProjectGroups({ runtimeEnvironmentId: 'env-1' })
    resolveCreate({
      id: 'rpc-create',
      ok: true,
      result: { group: projectGroup },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await pendingCreate

    expect(store.getState().projectGroups).toEqual([
      { ...projectGroup, executionHostId: 'runtime:env-1' }
    ])
  })

  it('restores a confirmed rename after an older catalog fetch removed the row', async () => {
    let resolveStaleList!: (value: unknown) => void
    let resolveUpdate!: (value: unknown) => void
    runtimeEnvironmentCall.mockImplementation(({ method }) => {
      if (method === 'projectGroup.list') {
        return new Promise((resolve) => {
          resolveStaleList = resolve
        })
      }
      if (method === 'projectGroup.update') {
        return new Promise((resolve) => {
          resolveUpdate = resolve
        })
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const runtimeGroup = { ...projectGroup, executionHostId: 'runtime:env-1' as const }
    const store = createTestStore()
    store.setState({ projectGroups: [runtimeGroup] })

    const staleFetch = store.getState().fetchProjectGroups({ runtimeEnvironmentId: 'env-1' })
    await vi.waitFor(() => expect(resolveStaleList).toBeTypeOf('function'))
    const pendingUpdate = store
      .getState()
      .updateProjectGroup(projectGroup.id, { name: 'Brass' }, { hostId: 'runtime:env-1' })
    await vi.waitFor(() => expect(resolveUpdate).toBeTypeOf('function'))

    resolveStaleList({
      id: 'rpc-stale-list',
      ok: true,
      result: { groups: [] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await staleFetch
    resolveUpdate({
      id: 'rpc-update',
      ok: true,
      result: { group: { ...projectGroup, name: 'Brass' } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await pendingUpdate

    expect(store.getState().projectGroups).toEqual([
      { ...projectGroup, name: 'Brass', executionHostId: 'runtime:env-1' }
    ])
  })

  it('does not resurrect a deleted runtime group from an older catalog fetch', async () => {
    let resolveStaleList!: (value: unknown) => void
    runtimeEnvironmentCall.mockImplementation(({ method }) => {
      if (method === 'projectGroup.list') {
        return new Promise((resolve) => {
          resolveStaleList = resolve
        })
      }
      if (method === 'projectGroup.delete') {
        return Promise.resolve({
          id: 'rpc-delete',
          ok: true,
          result: { deleted: true },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const runtimeGroup = { ...projectGroup, executionHostId: 'runtime:env-1' as const }
    const store = createTestStore()
    store.setState({ projectGroups: [runtimeGroup] })

    const staleFetch = store.getState().fetchProjectGroups({ runtimeEnvironmentId: 'env-1' })
    await vi.waitFor(() => expect(resolveStaleList).toBeTypeOf('function'))

    await expect(
      store.getState().deleteProjectGroup(projectGroup.id, { hostId: 'runtime:env-1' })
    ).resolves.toBe(true)

    resolveStaleList({
      id: 'rpc-stale-list',
      ok: true,
      result: { groups: [projectGroup] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await staleFetch

    expect(store.getState().projectGroups).toEqual([])
  })

  it('rejects a client-owned group for a paired runtime repo', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-invalid-move',
      ok: true,
      result: { repo: { ...remoteRepo, projectGroupId: projectGroup.id } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const ownedRemoteRepo = { ...remoteRepo, executionHostId: 'runtime:env-1' as const }
    const store = createTestStore()
    store.setState({
      repos: [ownedRemoteRepo],
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }]
    })

    await expect(store.getState().moveProjectToGroup(remoteRepo.id, projectGroup.id)).resolves.toBe(
      false
    )
    expect(store.getState().repos).toEqual([ownedRemoteRepo])
  })

  it('moves the requested paired repo when its id also exists locally', async () => {
    const runtimeGroup = { ...projectGroup, executionHostId: 'runtime:env-1' as const }
    const localRepo = { ...remoteRepo, path: '/local', executionHostId: 'local' as const }
    const runtimeRepo = {
      ...remoteRepo,
      path: '/runtime',
      executionHostId: 'runtime:env-1' as const
    }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-host-qualified-move',
      ok: true,
      result: { repo: { ...runtimeRepo, projectGroupId: runtimeGroup.id } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      repos: [localRepo, runtimeRepo],
      projectGroups: [runtimeGroup]
    })

    await expect(
      store.getState().moveProjectToGroup(remoteRepo.id, runtimeGroup.id, undefined, {
        hostId: 'runtime:env-1'
      })
    ).resolves.toBe(true)
    expect(store.getState().repos).toEqual([
      localRepo,
      { ...runtimeRepo, projectGroupId: runtimeGroup.id }
    ])
  })
})
