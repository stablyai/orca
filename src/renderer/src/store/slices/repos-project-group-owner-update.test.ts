import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { createTestStore } from './store-test-helpers'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

function group(executionHostId: 'local' | `runtime:${string}`): ProjectGroup {
  return {
    id: 'same-id',
    name: executionHostId,
    parentPath: null,
    executionHostId,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('project-group owner-qualified updates', () => {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('updates only the routed owner when ids overlap', async () => {
    const local = group('local')
    const runtime = group('runtime:env-1')
    const runtimeCall = vi.fn((request: RuntimeEnvironmentCallRequest) => {
      const compatibility = createCompatibleRuntimeStatusResponseIfNeeded(request)
      if (compatibility) {
        return compatibility
      }
      return {
        id: 'rpc-project-group-update',
        ok: true,
        result: { group: { ...runtime, tabOrder: 4 } },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeCall }
      }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      projectGroups: [local, runtime]
    })

    await store
      .getState()
      .updateProjectGroup('same-id', { tabOrder: 4 }, { ownerHostId: 'runtime:env-1' })

    expect(store.getState().projectGroups).toEqual([local, { ...runtime, tabOrder: 4 }])
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.update',
      params: { groupId: 'same-id', updates: { tabOrder: 4 } },
      timeoutMs: 15_000
    })
  })

  it('routes local updates by owner while a runtime is focused', async () => {
    const local = group('local')
    const runtime = group('runtime:env-1')
    const update = vi.fn().mockResolvedValue({ ...local, name: 'renamed' })
    vi.stubGlobal('window', {
      api: {
        projectGroups: { update },
        runtimeEnvironments: { call: vi.fn() }
      }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projectGroups: [local, runtime]
    })

    await store
      .getState()
      .updateProjectGroup('same-id', { name: 'renamed' }, { ownerHostId: 'local' })

    expect(update).toHaveBeenCalledWith({
      groupId: 'same-id',
      updates: { name: 'renamed' },
      ownerHostId: 'local'
    })
    expect(store.getState().projectGroups).toEqual([{ ...local, name: 'renamed' }, runtime])
  })

  it('does not update when an omitted owner is ambiguous', async () => {
    const local = group('local')
    const runtime = group('runtime:env-1')
    const runtimeCall = vi.fn()
    const update = vi.fn()
    vi.stubGlobal('window', {
      api: {
        projectGroups: { update },
        runtimeEnvironments: { call: runtimeCall }
      }
    })
    const store = createTestStore()
    store.setState({ projectGroups: [local, runtime] })

    await expect(store.getState().updateProjectGroup('same-id', { tabOrder: 4 })).resolves.toBe(
      false
    )

    expect(update).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual([local, runtime])
  })

  it('queries the owning runtime when target group metadata is stale', async () => {
    const runtimeRepo: Repo = {
      id: 'runtime-repo',
      path: '/runtime/repo',
      displayName: 'Runtime repo',
      badgeColor: '#111',
      addedAt: 1,
      projectGroupId: null,
      executionHostId: 'runtime:env-1'
    }
    const runtimeCall = vi.fn((request: RuntimeEnvironmentCallRequest) => {
      const compatibility = createCompatibleRuntimeStatusResponseIfNeeded(request)
      if (compatibility) {
        return compatibility
      }
      return {
        id: 'rpc-project-group-move',
        ok: true,
        result: { repo: { ...runtimeRepo, projectGroupId: 'runtime-group' } },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })
    const store = createTestStore()
    store.setState({ repos: [runtimeRepo], projectGroups: [] })

    await expect(
      store.getState().moveProjectToGroup(runtimeRepo.id, 'runtime-group')
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.moveProject',
      params: { repo: runtimeRepo.id, groupId: 'runtime-group', order: undefined },
      timeoutMs: 15_000
    })
    expect(store.getState().repos).toEqual([{ ...runtimeRepo, projectGroupId: 'runtime-group' }])
  })
})
