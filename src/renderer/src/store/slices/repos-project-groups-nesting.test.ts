import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const parentGroup: ProjectGroup = {
  id: 'group-parent',
  name: 'Perc',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const childGroup: ProjectGroup = {
  ...parentGroup,
  id: 'group-child',
  name: 'Backend',
  parentGroupId: parentGroup.id,
  tabOrder: 1
}

const projectGroupsCreate = vi.fn()
const projectGroupsUpdate = vi.fn()
const runtimeEnvironmentCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  projectGroupsCreate.mockReset()
  projectGroupsUpdate.mockReset()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      projectGroups: { create: projectGroupsCreate, update: projectGroupsUpdate },
      runtimeEnvironments: {
        call: (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
      }
    }
  })
})

describe('project group nesting store routing', () => {
  it('passes the parent to the local IPC when creating a subgroup', async () => {
    projectGroupsCreate.mockResolvedValue(childGroup)
    const store = createTestStore()
    store.setState({ projectGroups: [parentGroup] })

    await expect(
      store.getState().createProjectGroup('Backend', { parentGroupId: parentGroup.id })
    ).resolves.toEqual({ ...childGroup, executionHostId: 'local' })

    expect(projectGroupsCreate).toHaveBeenCalledWith({
      name: 'Backend',
      createdFrom: 'manual',
      parentGroupId: parentGroup.id
    })
    expect(store.getState().projectGroups.map((group) => group.id)).toEqual([
      parentGroup.id,
      childGroup.id
    ])
  })

  it('omits parentGroupId from the create payload for top-level groups', async () => {
    projectGroupsCreate.mockResolvedValue(parentGroup)
    const store = createTestStore()

    await store.getState().createProjectGroup('Perc', { parentGroupId: null })

    expect(projectGroupsCreate).toHaveBeenCalledWith({ name: 'Perc', createdFrom: 'manual' })
  })

  it('sends the parent over runtime RPC when the focused host is remote', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-create-group',
      ok: true,
      result: { group: childGroup },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await expect(
      store.getState().createProjectGroup('Backend', { parentGroupId: parentGroup.id })
    ).resolves.toEqual({ ...childGroup, executionHostId: 'runtime:env-1' })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.create',
      params: { name: 'Backend', createdFrom: 'manual', parentGroupId: parentGroup.id },
      timeoutMs: 15_000
    })
    expect(projectGroupsCreate).not.toHaveBeenCalled()
  })

  it('re-parents through updateProjectGroup and replaces the group in state', async () => {
    projectGroupsUpdate.mockResolvedValue({ ...childGroup, parentGroupId: null })
    const store = createTestStore()
    store.setState({ projectGroups: [parentGroup, childGroup] })

    await expect(
      store.getState().updateProjectGroup(childGroup.id, { parentGroupId: null })
    ).resolves.toBe(true)

    expect(projectGroupsUpdate).toHaveBeenCalledWith({
      groupId: childGroup.id,
      updates: { parentGroupId: null }
    })
    expect(
      store.getState().projectGroups.find((group) => group.id === childGroup.id)?.parentGroupId
    ).toBeNull()
  })

  it('returns false when the host rejects the re-parent', async () => {
    projectGroupsUpdate.mockRejectedValue(new Error('A project group cannot be moved into itself'))
    const store = createTestStore()
    store.setState({ projectGroups: [parentGroup, childGroup] })

    await expect(
      store.getState().updateProjectGroup(parentGroup.id, { parentGroupId: parentGroup.id })
    ).resolves.toBe(false)
    expect(
      store.getState().projectGroups.find((group) => group.id === parentGroup.id)?.parentGroupId
    ).toBeNull()
  })
})
