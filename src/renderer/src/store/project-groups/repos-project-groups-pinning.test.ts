import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'

describe('repos and project groups pinning store actions', () => {
  const remoteGroup: ProjectGroup = {
    id: 'group-1',
    name: 'Group 1',
    parentPath: null,
    parentGroupId: null,
    executionHostId: 'runtime:env-1',
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }

  const remoteRepo: Repo = {
    id: 'repo-1',
    path: '/srv/repo-1',
    displayName: 'Repo 1',
    badgeColor: '#111111',
    addedAt: 1,
    executionHostId: 'runtime:env-1',
    projectGroupId: 'group-1'
  }

  const projectGroupsDelete = vi.fn()
  const runtimeEnvironmentCall = vi.fn()
  const runtimeEnvironmentTransportCall = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    projectGroupsDelete.mockResolvedValue(true)
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    vi.stubGlobal('window', {
      api: {
        repos: { update: vi.fn() },
        projectGroups: {
          create: vi.fn(),
          update: vi.fn(),
          delete: projectGroupsDelete
        },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
      }
    })
  })

  it('rejects group and repo pin updates when an older remote host ignores isPinned, and adopts when applied', async () => {
    const store = createTestStore()
    store.setState({
      projectGroups: [remoteGroup],
      repos: [remoteRepo]
    })

    // Legacy remote ignores group isPinned
    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { group: { ...remoteGroup } }
    })
    await expect(
      store
        .getState()
        .updateProjectGroup('group-1', { isPinned: true }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(false)
    expect(store.getState().projectGroups[0]?.isPinned).toBeUndefined()

    // Compatible remote applies group isPinned
    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { group: { ...remoteGroup, isPinned: true } }
    })
    await expect(
      store
        .getState()
        .updateProjectGroup('group-1', { isPinned: true }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(true)
    expect(store.getState().projectGroups[0]?.isPinned).toBe(true)

    // Legacy remote ignores repo isPinned
    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { repo: { ...remoteRepo } }
    })
    await expect(
      store.getState().updateRepo('repo-1', { isPinned: true }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(false)
    expect(store.getState().repos[0]?.isPinned).toBeUndefined()

    // Compatible remote applies repo isPinned
    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { repo: { ...remoteRepo, isPinned: true } }
    })
    await expect(
      store.getState().updateRepo('repo-1', { isPinned: true }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(true)
    expect(store.getState().repos[0]?.isPinned).toBe(true)
  })

  it('rejects repo pin updates when the host returns null instead of merging locally', async () => {
    const store = createTestStore()
    store.setState({
      projectGroups: [remoteGroup],
      repos: [remoteRepo]
    })
    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { repo: null }
    })

    await expect(
      store.getState().updateRepo('repo-1', { isPinned: true }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(false)
    expect(store.getState().repos[0]?.isPinned).toBeUndefined()
  })

  it('clears isPinned on contained repos when deleting a project group in the renderer cascade', async () => {
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...remoteGroup, executionHostId: 'local' }],
      repos: [{ ...remoteRepo, executionHostId: 'local', isPinned: true }]
    })

    await expect(store.getState().deleteProjectGroup('group-1', { hostId: 'local' })).resolves.toBe(
      true
    )
    expect(store.getState().repos[0]).toMatchObject({
      projectGroupId: null,
      isPinned: false
    })
  })

  it('rejects group and repo unpin updates when an older remote host omits isPinned in the response', async () => {
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...remoteGroup, isPinned: true }],
      repos: [{ ...remoteRepo, isPinned: true }]
    })

    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { group: { ...remoteGroup } }
    })
    await expect(
      store
        .getState()
        .updateProjectGroup('group-1', { isPinned: false }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(false)
    expect(store.getState().projectGroups[0]?.isPinned).toBe(true)

    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { repo: { ...remoteRepo } }
    })
    await expect(
      store.getState().updateRepo('repo-1', { isPinned: false }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(false)
    expect(store.getState().repos[0]?.isPinned).toBe(true)

    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { group: { ...remoteGroup, isPinned: false } }
    })
    await expect(
      store
        .getState()
        .updateProjectGroup('group-1', { isPinned: false }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(true)
    expect(store.getState().projectGroups[0]?.isPinned).toBe(false)

    runtimeEnvironmentCall.mockResolvedValueOnce({
      ok: true,
      result: { repo: { ...remoteRepo, isPinned: false } }
    })
    await expect(
      store.getState().updateRepo('repo-1', { isPinned: false }, { hostId: 'runtime:env-1' })
    ).resolves.toBe(true)
    expect(store.getState().repos[0]?.isPinned).toBe(false)
  })
})
