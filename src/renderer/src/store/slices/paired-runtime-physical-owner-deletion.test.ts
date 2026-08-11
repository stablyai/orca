import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const localGroup: ProjectGroup = {
  id: 'shared-group',
  name: 'Local group',
  parentPath: '/local/project',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const sshTargetId = 'team/server'
const sshGroup: ProjectGroup = {
  ...localGroup,
  name: 'SSH group',
  parentPath: '/remote/project',
  connectionId: sshTargetId
}

function makeWorkspace(group: ProjectGroup): FolderWorkspace {
  return {
    id: 'shared-folder',
    projectGroupId: group.id,
    name: group.name,
    folderPath: group.parentPath!,
    connectionId: group.connectionId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation(
    (args: RuntimeEnvironmentCallRequest) =>
      createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  )
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('paired runtime physical-owner deletion', () => {
  it('deletes the visible same-id SSH folder from its encoded physical owner', async () => {
    const localWorkspace = makeWorkspace(localGroup)
    const sshWorkspace = makeWorkspace(sshGroup)
    runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) => {
      if (request.method === 'projectGroup.list') {
        return {
          id: 'rpc-list-groups',
          ok: true,
          result: { groups: [localGroup, sshGroup] },
          _meta: { runtimeId: 'runtime-owner' }
        }
      }
      if (request.method === 'folderWorkspace.list') {
        return {
          id: 'rpc-list-folders',
          ok: true,
          result: { folderWorkspaces: [localWorkspace, sshWorkspace] },
          _meta: { runtimeId: 'runtime-owner' }
        }
      }
      return {
        id: 'rpc-delete-folder',
        ok: true,
        result: { deleted: true },
        _meta: { runtimeId: 'runtime-owner' }
      }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-owner' } as never })

    await store.getState().fetchProjectGroups()
    await store.getState().fetchFolderWorkspaces()

    expect(store.getState().projectGroups).toEqual([
      {
        ...sshGroup,
        executionHostId: 'runtime:env-owner',
        runtimeSourceExecutionHostId: 'ssh:team%2Fserver'
      }
    ])
    expect(store.getState().folderWorkspaces).toEqual([
      {
        ...sshWorkspace,
        executionHostId: 'runtime:env-owner',
        runtimeSourceExecutionHostId: 'ssh:team%2Fserver'
      }
    ])
    await expect(store.getState().deleteFolderWorkspace(sshWorkspace.id)).resolves.toBe(true)

    expect(store.getState().folderWorkspaces).toEqual([])
    expect(
      runtimeEnvironmentCall.mock.calls.find(
        ([request]) => request.method === 'folderWorkspace.delete'
      )?.[0].params
    ).toEqual({
      folderWorkspaceId: sshWorkspace.id,
      executionHostId: 'ssh:team%2Fserver'
    })
  })

  it('keeps the visible local folder owner when catalog orders diverge', async () => {
    const localWorkspace = { ...makeWorkspace(localGroup), connectionId: null, sortOrder: 1 }
    const sshWorkspace = { ...makeWorkspace(sshGroup), sortOrder: 2 }
    runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) => {
      if (request.method === 'projectGroup.list') {
        return {
          id: 'rpc-list-groups',
          ok: true,
          result: { groups: [localGroup, sshGroup] },
          _meta: { runtimeId: 'runtime-owner' }
        }
      }
      if (request.method === 'folderWorkspace.list') {
        return {
          id: 'rpc-list-folders',
          ok: true,
          result: { folderWorkspaces: [sshWorkspace, localWorkspace] },
          _meta: { runtimeId: 'runtime-owner' }
        }
      }
      return {
        id: 'rpc-delete-folder',
        ok: true,
        result: { deleted: true },
        _meta: { runtimeId: 'runtime-owner' }
      }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-owner' } as never })

    await store.getState().fetchProjectGroups()
    await store.getState().fetchFolderWorkspaces()

    expect(store.getState().projectGroups).toEqual([
      {
        ...sshGroup,
        executionHostId: 'runtime:env-owner',
        runtimeSourceExecutionHostId: 'ssh:team%2Fserver'
      }
    ])
    expect(store.getState().folderWorkspaces).toEqual([
      {
        ...localWorkspace,
        executionHostId: 'runtime:env-owner',
        runtimeSourceExecutionHostId: 'local'
      }
    ])
    await expect(store.getState().deleteFolderWorkspace(localWorkspace.id)).resolves.toBe(true)

    expect(
      runtimeEnvironmentCall.mock.calls.find(
        ([request]) => request.method === 'folderWorkspace.delete'
      )?.[0].params
    ).toEqual({
      folderWorkspaceId: localWorkspace.id,
      executionHostId: 'local'
    })
  })

  it('rejects deletion when paired physical ownership remains ambiguous', async () => {
    const runtimeHostId = 'runtime:env-owner' as const
    const ambiguousWorkspace = {
      ...makeWorkspace(localGroup),
      connectionId: undefined,
      executionHostId: runtimeHostId
    }
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-owner' } as never,
      projectGroups: [
        {
          ...localGroup,
          executionHostId: runtimeHostId,
          runtimeSourceExecutionHostId: 'local'
        },
        {
          ...sshGroup,
          executionHostId: runtimeHostId,
          runtimeSourceExecutionHostId: 'ssh:team%2Fserver'
        }
      ],
      folderWorkspaces: [ambiguousWorkspace]
    })

    await expect(store.getState().deleteFolderWorkspace(ambiguousWorkspace.id)).resolves.toBe(false)
    await expect(store.getState().deleteProjectGroup(localGroup.id)).resolves.toBe(false)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(runtimeEnvironmentTransportCall.mock.calls.map(([request]) => request.method)).toEqual([
      'status.get'
    ])
  })

  it('deletes the visible same-id SSH group from its physical owner', async () => {
    runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) =>
      request.method === 'projectGroup.list'
        ? {
            id: 'rpc-list-groups',
            ok: true,
            result: { groups: [localGroup, sshGroup] },
            _meta: { runtimeId: 'runtime-owner' }
          }
        : {
            id: 'rpc-delete-group',
            ok: true,
            result: { deleted: true },
            _meta: { runtimeId: 'runtime-owner' }
          }
    )
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-owner' } as never })

    await store.getState().fetchProjectGroups()

    expect(store.getState().projectGroups).toEqual([
      {
        ...sshGroup,
        executionHostId: 'runtime:env-owner',
        runtimeSourceExecutionHostId: 'ssh:team%2Fserver'
      }
    ])
    await expect(store.getState().deleteProjectGroup(sshGroup.id)).resolves.toBe(true)

    expect(store.getState().projectGroups).toEqual([])
    expect(
      runtimeEnvironmentCall.mock.calls.find(
        ([request]) => request.method === 'projectGroup.delete'
      )?.[0].params
    ).toEqual({
      groupId: sshGroup.id,
      executionHostId: 'ssh:team%2Fserver'
    })
  })

  it('rejects owner-qualified group deletion with contradictory source authority', async () => {
    const contradictoryGroup = {
      ...localGroup,
      id: 'contradictory-group',
      connectionId: sshTargetId,
      executionHostId: 'runtime:env-owner' as const,
      runtimeSourceExecutionHostId: 'local' as const
    }
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-owner' } as never,
      projectGroups: [contradictoryGroup]
    })

    await expect(store.getState().deleteProjectGroup(contradictoryGroup.id)).resolves.toBe(false)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(runtimeEnvironmentTransportCall.mock.calls.map(([request]) => request.method)).toEqual([
      'status.get'
    ])
  })
})
