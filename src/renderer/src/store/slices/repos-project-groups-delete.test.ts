import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'

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
const reposRemoveForHost = vi.fn()
const projectGroupsDelete = vi.fn()
const projectGroupsUpdate = vi.fn()
const projectGroupsMoveProject = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposRemove.mockReset()
  reposRemoveForHost.mockReset()
  reposRemoveForHost.mockResolvedValue(undefined)
  reposRemove.mockResolvedValue(undefined)
  projectGroupsDelete.mockReset()
  projectGroupsUpdate.mockReset()
  projectGroupsMoveProject.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: { remove: reposRemove, removeForHost: reposRemoveForHost },
      projectGroups: {
        delete: projectGroupsDelete,
        update: projectGroupsUpdate,
        moveProject: projectGroupsMoveProject
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('project group deletion store routing', () => {
  it('routes a locally owned group to the local runtime when a remote runtime is active', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const locallyOwnedGroup = { ...projectGroup, executionHostId: 'local' }
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-1' }),
      projectGroups: [locallyOwnedGroup]
    })

    await expect(store.getState().deleteProjectGroup(locallyOwnedGroup.id)).resolves.toBe(true)

    expect(projectGroupsDelete).toHaveBeenCalledWith({ groupId: locallyOwnedGroup.id })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('removes an unstamped workspace by resolving its host through the deleted parent group', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-group',
      ok: true,
      result: { deleted: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const remotelyOwnedGroup = { ...projectGroup, executionHostId: 'runtime:env-1' }
    // Unstamped workspaces inherit the deleted group's host.
    const unstampedWorkspace: FolderWorkspace = {
      id: 'unstamped-workspace',
      projectGroupId: remotelyOwnedGroup.id,
      name: 'Remote workspace',
      folderPath: '/workspace/remote',
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
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-1' }),
      projectGroups: [remotelyOwnedGroup],
      folderWorkspaces: [unstampedWorkspace]
    })

    await expect(store.getState().deleteProjectGroup(remotelyOwnedGroup.id)).resolves.toBe(true)

    expect(store.getState().folderWorkspaces).toEqual([])
  })

  it('routes renames to the group owner instead of the active runtime', async () => {
    const locallyOwnedGroup = { ...projectGroup, executionHostId: 'local' }
    const renamedGroup = { ...locallyOwnedGroup, name: 'Renamed' }
    projectGroupsUpdate.mockResolvedValue(renamedGroup)
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-1' }),
      projectGroups: [locallyOwnedGroup]
    })

    await expect(
      store.getState().updateProjectGroup(locallyOwnedGroup.id, { name: renamedGroup.name })
    ).resolves.toBe(true)

    expect(projectGroupsUpdate).toHaveBeenCalledWith({
      groupId: locallyOwnedGroup.id,
      updates: { name: renamedGroup.name }
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('aborts instead of falling back to the active runtime when an explicit executionHostId owns nothing', async () => {
    const remoteGroup = { ...projectGroup, executionHostId: 'runtime:env-1' }
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-1' }),
      projectGroups: [remoteGroup]
    })

    await expect(
      store.getState().deleteProjectGroup(projectGroup.id, { executionHostId: 'local' })
    ).resolves.toBe(false)

    expect(projectGroupsDelete).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('disambiguates a mutation on a duplicate group id with an explicit executionHostId', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const localGroup = { ...projectGroup, executionHostId: 'local' }
    const remoteGroup = { ...projectGroup, executionHostId: 'runtime:env-1' }
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-1' }),
      projectGroups: [localGroup, remoteGroup]
    })

    await expect(
      store.getState().deleteProjectGroup(projectGroup.id, { executionHostId: 'local' })
    ).resolves.toBe(true)

    expect(projectGroupsDelete).toHaveBeenCalledWith({ groupId: projectGroup.id })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes a move to the project row host when a duplicate group id spans catalogs', async () => {
    const movedRepo = { ...remoteRepo, projectGroupId: projectGroup.id }
    projectGroupsMoveProject.mockResolvedValue(movedRepo)
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-1' }),
      repos: [remoteRepo],
      projectGroups: [
        { ...projectGroup, executionHostId: 'local' },
        { ...projectGroup, executionHostId: 'runtime:env-1' }
      ]
    })

    await expect(store.getState().moveProjectToGroup(remoteRepo, projectGroup.id, 3)).resolves.toBe(
      true
    )

    expect(projectGroupsMoveProject).toHaveBeenCalledWith({
      projectId: remoteRepo.id,
      groupId: projectGroup.id,
      order: 3,
      hostId: 'local'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes an ungroup to the project row host when a duplicate repo id spans catalogs', async () => {
    const localDupRepo: Repo = {
      ...remoteRepo,
      id: 'dup-repo',
      executionHostId: 'local',
      projectGroupId: projectGroup.id
    }
    const remoteDupRepo: Repo = {
      ...remoteRepo,
      id: 'dup-repo',
      executionHostId: 'runtime:env-1',
      projectGroupId: projectGroup.id
    }
    projectGroupsMoveProject.mockResolvedValue({ ...localDupRepo, projectGroupId: null })
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-1' }),
      repos: [localDupRepo, remoteDupRepo]
    })

    await expect(store.getState().moveProjectToGroup(localDupRepo, null)).resolves.toBe(true)

    expect(projectGroupsMoveProject).toHaveBeenCalledWith({
      projectId: 'dup-repo',
      groupId: null,
      order: undefined,
      hostId: 'local'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('scopes delete state reconciliation to the disambiguated host, leaving the sibling host untouched', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const localGroup = { ...projectGroup, executionHostId: 'local' }
    const remoteGroup = { ...projectGroup, executionHostId: 'runtime:env-1' }
    const localRepo: Repo = {
      ...remoteRepo,
      id: 'local-repo',
      executionHostId: 'local',
      projectGroupId: projectGroup.id
    }
    const remoteGroupedRepo: Repo = {
      ...remoteRepo,
      id: 'remote-grouped-repo',
      executionHostId: 'runtime:env-1',
      projectGroupId: projectGroup.id
    }
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-1' }),
      projectGroups: [localGroup, remoteGroup],
      repos: [localRepo, remoteGroupedRepo]
    })

    await expect(
      store.getState().deleteProjectGroup(projectGroup.id, { executionHostId: 'local' })
    ).resolves.toBe(true)

    expect(store.getState().projectGroups).toEqual([remoteGroup])
    expect(store.getState().repos).toEqual([
      { ...localRepo, projectGroupId: null },
      remoteGroupedRepo
    ])
  })

  it('does not delete an unrelated same-id local group reached only through the sibling host lineage', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const localRoot = { ...projectGroup, executionHostId: 'local' }
    const remoteRoot = { ...projectGroup, executionHostId: 'runtime:env-1' }
    // A sibling-host subtree must not contribute IDs to the local deletion.
    const remoteChild: ProjectGroup = {
      ...projectGroup,
      id: 'child-x',
      executionHostId: 'runtime:env-1',
      parentGroupId: remoteRoot.id
    }
    // This same-ID local row belongs to a different parent.
    const unrelatedLocalChild: ProjectGroup = {
      ...projectGroup,
      id: 'child-x',
      executionHostId: 'local',
      parentGroupId: 'some-other-local-group'
    }
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-1' }),
      projectGroups: [localRoot, remoteRoot, remoteChild, unrelatedLocalChild]
    })

    await expect(
      store.getState().deleteProjectGroup(projectGroup.id, { executionHostId: 'local' })
    ).resolves.toBe(true)

    expect(store.getState().projectGroups).toEqual([remoteRoot, remoteChild, unrelatedLocalChild])
  })

  it('scopes update state reconciliation to the disambiguated host, leaving the sibling host untouched', async () => {
    const localGroup = { ...projectGroup, executionHostId: 'local' }
    const remoteGroup = { ...projectGroup, executionHostId: 'runtime:env-1' }
    const renamedLocalGroup = { ...localGroup, name: 'Renamed' }
    projectGroupsUpdate.mockResolvedValue(renamedLocalGroup)
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-1' }),
      projectGroups: [localGroup, remoteGroup]
    })

    await expect(
      store
        .getState()
        .updateProjectGroup(projectGroup.id, { name: 'Renamed' }, { executionHostId: 'local' })
    ).resolves.toBe(true)

    expect(store.getState().projectGroups).toEqual([renamedLocalGroup, remoteGroup])
  })

  it('reports a contained-project removal as successful even when a same-id repo survives on another host', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const localDupRepo: Repo = {
      ...remoteRepo,
      id: 'dup-repo',
      executionHostId: 'local',
      projectGroupId: projectGroup.id
    }
    const remoteDupRepo: Repo = {
      ...remoteRepo,
      id: 'dup-repo',
      executionHostId: 'runtime:env-1',
      projectGroupId: null
    }
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup],
      repos: [localDupRepo, remoteDupRepo]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        removeContainedProjects: true
      })
    ).resolves.toEqual({
      status: 'deleted-group',
      groupId: projectGroup.id,
      requestedProjectIds: ['dup-repo'],
      removedProjectIds: ['dup-repo'],
      failedProjectRemovals: []
    })

    expect(reposRemoveForHost).toHaveBeenCalledWith({ repoId: 'dup-repo', hostId: 'local' })
    expect(store.getState().repos).toEqual([remoteDupRepo])
  })

  it('does not remove an unrelated same-id repo that belongs to a sibling-host group', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const localGroup = { ...projectGroup, executionHostId: 'local' }
    const remoteGroup = { ...projectGroup, executionHostId: 'runtime:env-1' }
    // A sibling-host member must not leak its ID into the local deletion.
    const remoteMemberRepo: Repo = {
      ...remoteRepo,
      id: 'dup-repo',
      executionHostId: 'runtime:env-1',
      projectGroupId: remoteGroup.id
    }
    // Why: same id, same host as the group being deleted, but not a member of it.
    const unrelatedLocalRepo: Repo = {
      ...remoteRepo,
      id: 'dup-repo',
      executionHostId: 'local',
      projectGroupId: null
    }
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-1' }),
      projectGroups: [localGroup, remoteGroup],
      repos: [remoteMemberRepo, unrelatedLocalRepo]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        removeContainedProjects: true,
        executionHostId: 'local'
      })
    ).resolves.toEqual({
      status: 'deleted-group',
      groupId: projectGroup.id,
      requestedProjectIds: [],
      removedProjectIds: [],
      failedProjectRemovals: []
    })

    expect(reposRemove).not.toHaveBeenCalled()
    expect(reposRemoveForHost).not.toHaveBeenCalled()
    expect(store.getState().repos).toEqual([remoteMemberRepo, unrelatedLocalRepo])
  })

  it('selects the owner-host repo for contained removal even when the sibling host row comes first', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const remoteDupRepo: Repo = {
      ...remoteRepo,
      id: 'dup-repo',
      executionHostId: 'runtime:env-1',
      projectGroupId: null
    }
    const localDupRepo: Repo = {
      ...remoteRepo,
      id: 'dup-repo',
      executionHostId: 'local',
      projectGroupId: projectGroup.id
    }
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup],
      // Why: the sibling-host row is listed before the owner-host row on purpose.
      repos: [remoteDupRepo, localDupRepo]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        removeContainedProjects: true
      })
    ).resolves.toEqual({
      status: 'deleted-group',
      groupId: projectGroup.id,
      requestedProjectIds: ['dup-repo'],
      removedProjectIds: ['dup-repo'],
      failedProjectRemovals: []
    })

    expect(reposRemoveForHost).toHaveBeenCalledWith({ repoId: 'dup-repo', hostId: 'local' })
  })

  it('reports missing-group instead of group-delete-failed when the group exists only on a sibling host', async () => {
    const remoteGroup = { ...projectGroup, executionHostId: 'runtime:env-1' }
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'env-1' }),
      projectGroups: [remoteGroup]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        executionHostId: 'local',
        removeContainedProjects: false
      })
    ).resolves.toEqual({
      status: 'missing-group',
      groupId: projectGroup.id,
      requestedProjectIds: [],
      removedProjectIds: [],
      failedProjectRemovals: []
    })

    expect(projectGroupsDelete).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual([remoteGroup])
  })

  it('rejects a stale hostId before deleting a focused same-id group with contained projects', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const localGroup = { ...projectGroup, executionHostId: 'local' }
    const localRepo = { ...remoteRepo, id: 'local-repo', projectGroupId: projectGroup.id }
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: null }),
      projectGroups: [localGroup],
      repos: [localRepo]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        removeContainedProjects: true,
        hostId: 'runtime:missing'
      })
    ).resolves.toEqual({
      status: 'missing-group',
      groupId: projectGroup.id,
      requestedProjectIds: [],
      removedProjectIds: [],
      failedProjectRemovals: []
    })

    expect(projectGroupsDelete).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(reposRemove).not.toHaveBeenCalled()
    expect(reposRemoveForHost).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual([localGroup])
    expect(store.getState().repos).toEqual([localRepo])
  })
})
