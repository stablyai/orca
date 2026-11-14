import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'

import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { replaceRuntimeEnvironmentRevisions } from '../../runtime/rpc/environment-revisions/runtime-environment-revision'

describe('repos-project-groups-delete', () => {
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
  const runtimeEnvironmentCall = vi.fn()
  const runtimeEnvironmentTransportCall = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    // Shared-process runs can leave another file's env-1 pairing revision behind.
    replaceRuntimeEnvironmentRevisions([])
    reposRemove.mockReset()
    reposRemoveForHost.mockReset()
    reposRemoveForHost.mockResolvedValue(undefined)
    reposRemove.mockResolvedValue(undefined)
    projectGroupsDelete.mockReset()
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentTransportCall.mockReset()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    vi.stubGlobal('window', {
      api: {
        repos: { remove: reposRemove, removeForHost: reposRemoveForHost },
        projectGroups: { delete: projectGroupsDelete },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
      }
    })
  })

  describe('project group deletion store routing', () => {
    it('removes an unstamped local group member rather than its focused same-ID sibling', async () => {
      const localMember: Repo = {
        ...remoteRepo,
        id: 'dup-repo',
        executionHostId: 'local',
        projectGroupId: projectGroup.id
      }
      const remoteSibling: Repo = {
        ...remoteRepo,
        id: 'dup-repo',
        executionHostId: 'runtime:env-1',
        projectGroupId: null
      }
      projectGroupsDelete.mockResolvedValue(true)
      const store = createTestStore()
      store.setState({
        settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
        projectGroups: [projectGroup],
        repos: [remoteSibling, localMember]
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
      expect(store.getState().repos).toEqual([remoteSibling])
    })

    it('does not cascade through a sibling-host child into unrelated local rows', async () => {
      const remoteChild: ProjectGroup = {
        ...projectGroup,
        id: 'child',
        parentGroupId: projectGroup.id,
        executionHostId: 'runtime:env-1'
      }
      const unrelatedLocalChild: ProjectGroup = {
        ...projectGroup,
        id: 'child',
        parentGroupId: 'another-local-root',
        executionHostId: 'local'
      }
      const remoteMember: Repo = {
        ...remoteRepo,
        id: 'dup-repo',
        executionHostId: 'runtime:env-1',
        projectGroupId: remoteChild.id
      }
      const unrelatedLocalRepo: Repo = {
        ...remoteRepo,
        id: 'dup-repo',
        executionHostId: 'local',
        projectGroupId: null
      }
      projectGroupsDelete.mockResolvedValue(true)
      const store = createTestStore()
      store.setState({
        settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
        projectGroups: [projectGroup, remoteChild, unrelatedLocalChild],
        repos: [remoteMember, unrelatedLocalRepo]
      })

      await expect(
        store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
          removeContainedProjects: true
        })
      ).resolves.toEqual({
        status: 'deleted-group',
        groupId: projectGroup.id,
        requestedProjectIds: [],
        removedProjectIds: [],
        failedProjectRemovals: []
      })
      expect(store.getState().projectGroups).toEqual([remoteChild, unrelatedLocalChild])
      expect(store.getState().repos).toEqual([remoteMember, unrelatedLocalRepo])
    })

    it('refuses a stale explicit owner before selecting or deleting contained projects', async () => {
      const member = { ...remoteRepo, projectGroupId: projectGroup.id }
      projectGroupsDelete.mockResolvedValue(true)
      const store = createTestStore()
      store.setState({ projectGroups: [projectGroup], repos: [member] })

      await expect(
        store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
          hostId: 'runtime:missing',
          removeContainedProjects: true
        })
      ).resolves.toEqual({
        status: 'missing-group',
        groupId: projectGroup.id,
        requestedProjectIds: [],
        removedProjectIds: [],
        failedProjectRemovals: []
      })
      expect(store.getState().projectGroups).toEqual([projectGroup])
      expect(store.getState().repos).toEqual([member])
    })

    it('uses the remote delete response shape before mutating local state', async () => {
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'rpc-delete-group',
        ok: true,
        result: { deleted: false },
        _meta: { runtimeId: 'runtime-remote' }
      })
      const serverGroup = { ...projectGroup, executionHostId: 'runtime:env-1' as const }
      const groupedRepo = { ...remoteRepo, projectGroupId: projectGroup.id }
      const store = createTestStore()
      store.setState({
        settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
        projectGroups: [serverGroup],
        repos: [groupedRepo]
      })

      await expect(store.getState().deleteProjectGroup(projectGroup.id)).resolves.toBe(false)

      expect(store.getState().projectGroups).toEqual([serverGroup])
      expect(store.getState().repos).toEqual([groupedRepo])
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'projectGroup.delete',
        params: { groupId: projectGroup.id },
        timeoutMs: 15_000
      })
      expect(projectGroupsDelete).not.toHaveBeenCalled()
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

      expect(reposRemoveForHost).toHaveBeenCalledWith({ repoId: 'direct', hostId: 'local' })
      expect(reposRemoveForHost).toHaveBeenCalledWith({ repoId: 'nested', hostId: 'local' })
      expect(reposRemove).not.toHaveBeenCalled()
      expect(store.getState().repos).toEqual([siblingRepo])
    })

    it('processes local/direct-SSH same-ID contained rows sequentially', async () => {
      const localRepo = {
        ...remoteRepo,
        id: 'shared',
        path: '/local/shared',
        projectGroupId: projectGroup.id,
        executionHostId: 'local' as const
      }
      const sshRepo = {
        ...localRepo,
        path: '/ssh/shared',
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1' as const
      }
      projectGroupsDelete.mockResolvedValue(true)
      const store = createTestStore()
      store.setState({
        projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
        repos: [localRepo, sshRepo],
        settings: { activeRuntimeEnvironmentId: null } as never
      })

      await expect(
        store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
          removeContainedProjects: true
        })
      ).resolves.toEqual({
        status: 'deleted-group',
        groupId: projectGroup.id,
        requestedProjectIds: ['shared', 'shared'],
        removedProjectIds: ['shared'],
        failedProjectRemovals: []
      })

      expect(reposRemoveForHost).toHaveBeenCalledWith({
        repoId: 'shared',
        hostId: 'local'
      })
      expect(reposRemoveForHost).toHaveBeenCalledWith({
        repoId: 'shared',
        hostId: 'ssh:ssh-1'
      })
      expect(reposRemove).not.toHaveBeenCalled()
      expect(store.getState().repos).toEqual([])
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
      reposRemoveForHost.mockImplementation(async ({ repoId }: { repoId: string }) => {
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
})
