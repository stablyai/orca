import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2
}

const projectGroup: ProjectGroup = {
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

const reposRemove = vi.fn()
const projectGroupsDelete = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposRemove.mockReset()
  reposRemove.mockResolvedValue(undefined)
  projectGroupsDelete.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: { remove: reposRemove },
      projectGroups: { delete: projectGroupsDelete },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('project group deletion store routing', () => {
  it('removes local project group subtrees from renderer state after delete', async () => {
    const childGroup: ProjectGroup = {
      ...projectGroup,
      id: 'child',
      parentGroupId: projectGroup.id
    }
    const siblingGroup: ProjectGroup = {
      ...projectGroup,
      id: 'sibling',
      name: 'Tools',
      tabOrder: 1
    }
    const childWorkspace: FolderWorkspace = {
      id: 'folder-workspace-1',
      projectGroupId: childGroup.id,
      name: 'Shared cleanup',
      folderPath: '/workspace/platform/shared',
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
    projectGroupsDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup, childGroup, siblingGroup],
      folderWorkspaces: [childWorkspace],
      repos: [
        { ...remoteRepo, id: 'direct', projectGroupId: projectGroup.id },
        { ...remoteRepo, id: 'nested', projectGroupId: childGroup.id },
        { ...remoteRepo, id: 'sibling', projectGroupId: siblingGroup.id }
      ]
    })

    await expect(store.getState().deleteProjectGroup(projectGroup.id)).resolves.toBe(true)

    expect(store.getState().projectGroups.map((group) => group.id)).toEqual([siblingGroup.id])
    expect(store.getState().folderWorkspaces).toEqual([])
    expect(store.getState().repos).toMatchObject([
      { id: 'direct', projectGroupId: null },
      { id: 'nested', projectGroupId: null },
      { id: 'sibling', projectGroupId: siblingGroup.id }
    ])
  })

  it('uses the remote delete response shape before mutating local state', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-group',
      ok: true,
      result: { deleted: false },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const groupedRepo = { ...remoteRepo, projectGroupId: projectGroup.id }
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projectGroups: [projectGroup],
      repos: [groupedRepo]
    })

    await expect(store.getState().deleteProjectGroup(projectGroup.id)).resolves.toBe(false)

    expect(store.getState().projectGroups).toEqual([projectGroup])
    expect(store.getState().repos).toEqual([groupedRepo])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.delete',
      params: { groupId: projectGroup.id },
      timeoutMs: 15_000
    })
    expect(projectGroupsDelete).not.toHaveBeenCalled()
  })

  it('deletes only the group when contained project removal is not requested', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const groupedRepo = { ...remoteRepo, id: 'direct', projectGroupId: projectGroup.id }
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup],
      repos: [groupedRepo]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        removeContainedProjects: false
      })
    ).resolves.toEqual({
      status: 'deleted-group',
      groupId: projectGroup.id,
      requestedProjectIds: [],
      removedProjectIds: [],
      failedProjectRemovals: []
    })

    expect(reposRemove).not.toHaveBeenCalled()
    expect(store.getState().repos).toMatchObject([{ id: 'direct', projectGroupId: null }])
  })

  it('removes direct and nested child projects after deleting a group', async () => {
    const childGroup: ProjectGroup = {
      ...projectGroup,
      id: 'child',
      parentGroupId: projectGroup.id
    }
    const siblingRepo = { ...remoteRepo, id: 'sibling', projectGroupId: null }
    projectGroupsDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup, childGroup],
      repos: [
        { ...remoteRepo, id: 'direct', projectGroupId: projectGroup.id },
        { ...remoteRepo, id: 'nested', projectGroupId: childGroup.id },
        siblingRepo
      ]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        removeContainedProjects: true
      })
    ).resolves.toEqual({
      status: 'deleted-group',
      groupId: projectGroup.id,
      requestedProjectIds: ['direct', 'nested'],
      removedProjectIds: ['direct', 'nested'],
      failedProjectRemovals: []
    })

    expect(reposRemove).toHaveBeenCalledWith({ repoId: 'direct' })
    expect(reposRemove).toHaveBeenCalledWith({ repoId: 'nested' })
    expect(store.getState().repos).toEqual([siblingRepo])
  })

  it('does not remove contained projects when group deletion fails', async () => {
    projectGroupsDelete.mockResolvedValue(false)
    const groupedRepo = { ...remoteRepo, id: 'direct', projectGroupId: projectGroup.id }
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup],
      repos: [groupedRepo]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        removeContainedProjects: true
      })
    ).resolves.toEqual({
      status: 'group-delete-failed',
      groupId: projectGroup.id,
      requestedProjectIds: ['direct'],
      removedProjectIds: [],
      failedProjectRemovals: []
    })

    expect(reposRemove).not.toHaveBeenCalled()
    expect(store.getState().repos).toEqual([groupedRepo])
  })

  it('reports project removal failures by comparing store state after removeProject', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    reposRemove.mockImplementation(async ({ repoId }: { repoId: string }) => {
      if (repoId === 'nested') {
        throw new Error('remove failed')
      }
    })
    const childGroup: ProjectGroup = {
      ...projectGroup,
      id: 'child',
      parentGroupId: projectGroup.id
    }
    projectGroupsDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup, childGroup],
      repos: [
        { ...remoteRepo, id: 'direct', projectGroupId: projectGroup.id },
        { ...remoteRepo, id: 'nested', projectGroupId: childGroup.id }
      ]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        removeContainedProjects: true
      })
    ).resolves.toEqual({
      status: 'deleted-group',
      groupId: projectGroup.id,
      requestedProjectIds: ['direct', 'nested'],
      removedProjectIds: ['direct'],
      failedProjectRemovals: [
        {
          projectId: 'nested',
          reason: 'Project remained in Orca after removeProject completed.'
        }
      ]
    })

    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['nested'])
    consoleError.mockRestore()
  })
})
