import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const baseGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const localGroup: ProjectGroup = { ...baseGroup, executionHostId: 'local' }
const remoteGroup: ProjectGroup = {
  ...baseGroup,
  id: 'group-remote',
  executionHostId: 'runtime:env-1'
}

const projectGroupsUpdate = vi.fn()
const projectGroupsDelete = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  projectGroupsUpdate.mockReset()
  projectGroupsDelete.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: { remove: vi.fn() },
      projectGroups: { update: projectGroupsUpdate, delete: projectGroupsDelete },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('project group writes route by owning host', () => {
  it('deletes a local group locally while a runtime environment is focused', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projectGroups: [localGroup]
    })

    await expect(store.getState().deleteProjectGroup(localGroup.id)).resolves.toBe(true)

    expect(projectGroupsDelete).toHaveBeenCalledWith({ groupId: localGroup.id })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual([])
  })

  it('renames a local group locally while a runtime environment is focused', async () => {
    projectGroupsUpdate.mockResolvedValue({ ...localGroup, name: 'Renamed' })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projectGroups: [localGroup]
    })

    await expect(
      store.getState().updateProjectGroup(localGroup.id, { name: 'Renamed' })
    ).resolves.toBe(true)

    expect(projectGroupsUpdate).toHaveBeenCalledWith({
      groupId: localGroup.id,
      updates: { name: 'Renamed' }
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toMatchObject([{ name: 'Renamed' }])
  })

  it('deletes a runtime-owned group on its own host while local is focused', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-group',
      ok: true,
      result: { deleted: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      projectGroups: [remoteGroup]
    })

    await expect(store.getState().deleteProjectGroup(remoteGroup.id)).resolves.toBe(true)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.delete',
      params: { groupId: remoteGroup.id },
      timeoutMs: 15_000
    })
    expect(projectGroupsDelete).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual([])
  })

  it('keeps using the focused host for groups with no recorded owner', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-group',
      ok: true,
      result: { deleted: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projectGroups: [baseGroup]
    })

    await expect(store.getState().deleteProjectGroup(baseGroup.id)).resolves.toBe(true)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.delete',
      params: { groupId: baseGroup.id },
      timeoutMs: 15_000
    })
    expect(projectGroupsDelete).not.toHaveBeenCalled()
  })
})
