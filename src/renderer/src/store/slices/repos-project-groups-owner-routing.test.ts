import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const folderScanGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Projects',
  parentPath: '/srv/projects',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const baseRepo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#111',
  addedAt: 1
}

const baseFolderWorkspace: FolderWorkspace = {
  id: 'folder-workspace-1',
  projectGroupId: folderScanGroup.id,
  name: 'Notes',
  folderPath: '/srv/projects/notes',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 1,
  lastActivityAt: 0,
  createdAt: 1,
  updatedAt: 1
}

const projectGroupsUpdate = vi.fn()
const projectGroupsDelete = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  projectGroupsUpdate.mockResolvedValue(null)
  projectGroupsDelete.mockResolvedValue(false)
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

function runtimeRpcResponse(result: unknown) {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-remote' } }
}

describe('project group mutations route to the owning host', () => {
  it('renames a runtime-owned folder-scan group while the local host is focused', async () => {
    const runtimeGroup: ProjectGroup = { ...folderScanGroup, executionHostId: 'runtime:env-1' }
    runtimeEnvironmentCall.mockResolvedValue(
      runtimeRpcResponse({ group: { ...runtimeGroup, name: 'Renamed' } })
    )
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      projectGroups: [runtimeGroup]
    })

    await expect(
      store.getState().updateProjectGroup(runtimeGroup.id, { name: 'Renamed' })
    ).resolves.toBe(true)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.update',
      params: { groupId: runtimeGroup.id, updates: { name: 'Renamed' } },
      timeoutMs: 15_000
    })
    expect(projectGroupsUpdate).not.toHaveBeenCalled()
    expect(store.getState().projectGroups[0]).toMatchObject({
      name: 'Renamed',
      executionHostId: 'runtime:env-1'
    })
  })

  it('deletes a local folder-scan group while a runtime host is focused', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projectGroups: [{ ...folderScanGroup, executionHostId: 'local' }]
    })

    await expect(store.getState().deleteProjectGroup(folderScanGroup.id)).resolves.toBe(true)

    expect(projectGroupsDelete).toHaveBeenCalledWith({ groupId: folderScanGroup.id })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual([])
  })

  it('routes a direct-SSH group through the local catalog, not the focused runtime', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projectGroups: [{ ...folderScanGroup, connectionId: 'conn-1' }]
    })

    await expect(store.getState().deleteProjectGroup(folderScanGroup.id)).resolves.toBe(true)

    expect(projectGroupsDelete).toHaveBeenCalledWith({ groupId: folderScanGroup.id })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('prefers an explicit hostId over both the focused host and a colliding row', async () => {
    runtimeEnvironmentCall.mockResolvedValue(runtimeRpcResponse({ deleted: true }))
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      projectGroups: [
        { ...folderScanGroup, executionHostId: 'local' },
        { ...folderScanGroup, executionHostId: 'runtime:env-1' }
      ]
    })

    await expect(
      store.getState().deleteProjectGroup(folderScanGroup.id, { hostId: 'runtime:env-1' })
    ).resolves.toBe(true)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.delete',
      params: { groupId: folderScanGroup.id },
      timeoutMs: 15_000
    })
    expect(projectGroupsDelete).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toMatchObject([{ executionHostId: 'local' }])
  })

  it('keeps the focused host when a colliding id has no unambiguous owner', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      projectGroups: [
        { ...folderScanGroup, executionHostId: 'local' },
        { ...folderScanGroup, executionHostId: 'runtime:env-1' }
      ]
    })

    await expect(store.getState().deleteProjectGroup(folderScanGroup.id)).resolves.toBe(true)

    expect(projectGroupsDelete).toHaveBeenCalledWith({ groupId: folderScanGroup.id })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  // Why: a lost connection is unverifiable, not a refusal - the failure toast copy must stay non-asserting.
  it('reports an unreachable owner as failure without touching local state', async () => {
    const runtimeGroup: ProjectGroup = { ...folderScanGroup, executionHostId: 'runtime:env-1' }
    runtimeEnvironmentCall.mockRejectedValue(new Error('runtime rpc timed out'))
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      projectGroups: [runtimeGroup],
      folderWorkspaces: [baseFolderWorkspace]
    })

    await expect(
      store.getState().updateProjectGroup(runtimeGroup.id, { name: 'Renamed' })
    ).resolves.toBe(false)
    await expect(store.getState().deleteProjectGroup(runtimeGroup.id)).resolves.toBe(false)

    expect(projectGroupsUpdate).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual([runtimeGroup])
    expect(store.getState().folderWorkspaces).toEqual([baseFolderWorkspace])
  })
})

describe('project group state cascades stay scoped to the owner host', () => {
  it('leaves another host rows intact when deleting a colliding local group', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const runtimeChild: ProjectGroup = {
      ...folderScanGroup,
      id: 'child',
      parentGroupId: folderScanGroup.id,
      executionHostId: 'runtime:env-1'
    }
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      projectGroups: [
        { ...folderScanGroup, executionHostId: 'local' },
        { ...folderScanGroup, name: 'Remote projects', executionHostId: 'runtime:env-1' },
        runtimeChild
      ],
      folderWorkspaces: [
        { ...baseFolderWorkspace, executionHostId: 'local' },
        {
          ...baseFolderWorkspace,
          id: 'folder-workspace-remote',
          executionHostId: 'runtime:env-1'
        }
      ],
      repos: [
        { ...baseRepo, id: 'local-repo', projectGroupId: folderScanGroup.id },
        {
          ...baseRepo,
          id: 'remote-repo',
          projectGroupId: folderScanGroup.id,
          executionHostId: 'runtime:env-1'
        }
      ]
    })

    await expect(
      store.getState().deleteProjectGroup(folderScanGroup.id, { hostId: 'local' })
    ).resolves.toBe(true)

    expect(store.getState().projectGroups).toMatchObject([
      { id: folderScanGroup.id, executionHostId: 'runtime:env-1' },
      { id: 'child', executionHostId: 'runtime:env-1' }
    ])
    expect(store.getState().folderWorkspaces.map((workspace) => workspace.id)).toEqual([
      'folder-workspace-remote'
    ])
    expect(store.getState().repos).toMatchObject([
      { id: 'local-repo', projectGroupId: null },
      { id: 'remote-repo', projectGroupId: folderScanGroup.id }
    ])
  })

  it('renames only the owner host row when the id exists on two hosts', async () => {
    projectGroupsUpdate.mockResolvedValue({
      ...folderScanGroup,
      executionHostId: 'local',
      name: 'Renamed'
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      projectGroups: [
        { ...folderScanGroup, executionHostId: 'local' },
        { ...folderScanGroup, name: 'Remote projects', executionHostId: 'runtime:env-1' }
      ]
    })

    await expect(
      store.getState().updateProjectGroup(
        folderScanGroup.id,
        { name: 'Renamed' },
        {
          hostId: 'local'
        }
      )
    ).resolves.toBe(true)

    expect(store.getState().projectGroups).toMatchObject([
      { name: 'Renamed', executionHostId: 'local' },
      { name: 'Remote projects', executionHostId: 'runtime:env-1' }
    ])
  })

  it('removes contained projects only from the owner host', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const reposRemove = vi.fn().mockResolvedValue(undefined)
    const reposRemoveForHost = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: {
        repos: { remove: reposRemove, removeForHost: reposRemoveForHost },
        projectGroups: { update: projectGroupsUpdate, delete: projectGroupsDelete },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
      }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as never,
      projectGroups: [
        { ...folderScanGroup, executionHostId: 'local' },
        { ...folderScanGroup, executionHostId: 'runtime:env-1' }
      ],
      repos: [
        { ...baseRepo, id: 'local-repo', projectGroupId: folderScanGroup.id },
        {
          ...baseRepo,
          id: 'remote-repo',
          projectGroupId: folderScanGroup.id,
          executionHostId: 'runtime:env-1'
        }
      ]
    })

    const result = await store
      .getState()
      .deleteProjectGroupWithContainedProjects(folderScanGroup.id, {
        removeContainedProjects: true,
        hostId: 'local'
      })

    expect(result).toMatchObject({
      status: 'deleted-group',
      requestedProjectIds: ['local-repo'],
      removedProjectIds: ['local-repo']
    })
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['remote-repo'])
  })
})
