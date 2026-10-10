import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { PROJECT_GROUP_NESTING_RUNTIME_CAPABILITY } from '../../../../shared/project-group-nesting-capability'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const parentGroup: ProjectGroup = {
  id: 'parent',
  name: 'Parent',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}
const childGroup: ProjectGroup = { ...parentGroup, id: 'child', name: 'Child', tabOrder: 1 }
const stalePathStatuses = {
  stale: {
    status: { path: '/stale', exists: false },
    checkedAt: 1,
    requestSnapshot: 'stale'
  }
}

const projectGroupsCreate = vi.fn()
const projectGroupsUpdate = vi.fn()
const runtimeEnvironmentCall = vi.fn()
let hostAdvertisesNesting = true

function statusResponse(request: RuntimeEnvironmentCallRequest) {
  const response = createCompatibleRuntimeStatusResponseIfNeeded(request)
  if (!response?.ok || hostAdvertisesNesting) {
    return response
  }
  const capabilities = response.result.capabilities?.filter(
    (capability) => capability !== PROJECT_GROUP_NESTING_RUNTIME_CAPABILITY
  )
  return { ...response, result: { ...response.result, capabilities } }
}

function runtimeRpcResponse(result: unknown) {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-remote' } }
}

function createStoreWith(groups: ProjectGroup[], activeRuntimeEnvironmentId: string | null) {
  const store = createTestStore()
  store.setState({
    settings: { ...getDefaultSettings('/test'), activeRuntimeEnvironmentId },
    projectGroups: groups,
    folderWorkspacePathStatuses: stalePathStatuses
  })
  return store
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  hostAdvertisesNesting = true
  vi.stubGlobal('window', {
    api: {
      projectGroups: { create: projectGroupsCreate, update: projectGroupsUpdate },
      runtimeEnvironments: {
        call: (request: RuntimeEnvironmentCallRequest) =>
          statusResponse(request) ?? runtimeEnvironmentCall(request)
      }
    }
  })
})

describe('createProjectGroup with a parent group', () => {
  it("creates the subgroup on the parent's runtime host and SSH target while the local host is focused", async () => {
    // Why: hosts older than nesting do not inherit the parent's SSH target, so the client sends it.
    const runtimeParent = {
      ...parentGroup,
      connectionId: 'remote-ssh',
      executionHostId: 'runtime:env-1'
    }
    runtimeEnvironmentCall.mockResolvedValue(
      runtimeRpcResponse({ group: { ...childGroup, parentGroupId: 'parent' } })
    )
    const store = createStoreWith(
      [{ ...parentGroup, executionHostId: 'local' }, runtimeParent],
      null
    )

    const created = await store
      .getState()
      .createProjectGroup('Child', { parentGroupId: 'parent', hostId: 'runtime:env-1' })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.create',
      params: {
        name: 'Child',
        createdFrom: 'manual',
        parentGroupId: 'parent',
        connectionId: 'remote-ssh'
      },
      timeoutMs: 15_000
    })
    expect(projectGroupsCreate).not.toHaveBeenCalled()
    expect(created).toMatchObject({ parentGroupId: 'parent', executionHostId: 'runtime:env-1' })
    expect(store.getState().projectGroups).toContainEqual(created)
  })

  it('keeps the plain create payload and focused-host routing unchanged', async () => {
    projectGroupsCreate.mockResolvedValue(childGroup)
    const store = createStoreWith([{ ...parentGroup, executionHostId: 'runtime:env-1' }], null)

    await store.getState().createProjectGroup('Child')

    expect(projectGroupsCreate.mock.calls).toStrictEqual([
      [{ name: 'Child', createdFrom: 'manual' }]
    ])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})

describe('moveProjectGroup', () => {
  it('sends the new parent alone over IPC and stores the moved group', async () => {
    const moved = { ...childGroup, parentGroupId: 'parent', tabOrder: 7 }
    projectGroupsUpdate.mockResolvedValue(moved)
    const store = createStoreWith([parentGroup, childGroup], null)

    await expect(store.getState().moveProjectGroup('child', 'parent')).resolves.toBe(true)

    expect(projectGroupsUpdate.mock.calls).toStrictEqual([
      [{ groupId: 'child', updates: { parentGroupId: 'parent' } }]
    ])
    expect(store.getState().projectGroups[1]).toEqual({ ...moved, executionHostId: 'local' })
    expect(store.getState().folderWorkspacePathStatuses).toEqual({})
  })

  it('moves a runtime-owned group to the top level through its owner host', async () => {
    const runtimeChild = {
      ...childGroup,
      parentGroupId: 'parent',
      executionHostId: 'runtime:env-1'
    }
    runtimeEnvironmentCall.mockResolvedValue(
      runtimeRpcResponse({ group: { ...childGroup, parentGroupId: null } })
    )
    const store = createStoreWith([runtimeChild], null)

    await expect(
      store.getState().moveProjectGroup('child', null, { hostId: 'runtime:env-1' })
    ).resolves.toBe(true)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.update',
      params: { groupId: 'child', updates: { parentGroupId: null } },
      timeoutMs: 15_000
    })
    expect(store.getState().projectGroups).toEqual([
      { ...childGroup, parentGroupId: null, executionHostId: 'runtime:env-1' }
    ])
  })

  it('does not send the move to a runtime host that lacks group nesting', async () => {
    hostAdvertisesNesting = false
    const runtimeGroups = [parentGroup, childGroup].map((group) => ({
      ...group,
      executionHostId: 'runtime:env-1'
    }))
    const store = createStoreWith(runtimeGroups, 'env-1')

    await expect(store.getState().moveProjectGroup('child', 'parent')).resolves.toBe(false)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual(runtimeGroups)
  })

  it('reports failure when the host answers with the group still under its old parent', async () => {
    const runtimeGroups = [parentGroup, childGroup].map((group) => ({
      ...group,
      executionHostId: 'runtime:env-1'
    }))
    runtimeEnvironmentCall.mockResolvedValue(runtimeRpcResponse({ group: childGroup }))
    const store = createStoreWith(runtimeGroups, 'env-1')

    await expect(store.getState().moveProjectGroup('child', 'parent')).resolves.toBe(false)

    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(store.getState().projectGroups).toEqual(runtimeGroups)
  })

  it('reports a rejected move as failure without touching state', async () => {
    projectGroupsUpdate.mockRejectedValue(
      new Error('A project group cannot be moved into one of its subgroups.')
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createStoreWith([parentGroup, childGroup], null)

    await expect(store.getState().moveProjectGroup('parent', 'child')).resolves.toBe(false)

    expect(store.getState().projectGroups).toEqual([parentGroup, childGroup])
    expect(store.getState().folderWorkspacePathStatuses).toEqual(stalePathStatuses)
  })
})
