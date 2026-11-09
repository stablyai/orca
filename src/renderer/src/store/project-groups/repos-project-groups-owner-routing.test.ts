import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'

describe('repos-project-groups-owner-routing', () => {
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

  const projectGroupsCreate = vi.fn()
  const projectGroupsUpdate = vi.fn()
  const projectGroupsDelete = vi.fn()
  const runtimeEnvironmentCall = vi.fn()
  const runtimeEnvironmentTransportCall = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    projectGroupsCreate.mockResolvedValue(null)
    projectGroupsUpdate.mockResolvedValue(null)
    projectGroupsDelete.mockResolvedValue(false)
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    vi.stubGlobal('window', {
      api: {
        repos: {},
        projectGroups: {
          create: projectGroupsCreate,
          update: projectGroupsUpdate,
          delete: projectGroupsDelete
        },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
      }
    })
  })

  describe('project group mutations route to the owning host', () => {
    it('refuses, rather than following focus, when a colliding id has no unambiguous owner', async () => {
      projectGroupsDelete.mockResolvedValue(true)
      const store = createTestStore()
      store.setState({
        settings: { activeRuntimeEnvironmentId: null } as never,
        projectGroups: [
          { ...folderScanGroup, executionHostId: 'local' },
          { ...folderScanGroup, executionHostId: 'runtime:env-1' }
        ]
      })

      await expect(store.getState().deleteProjectGroup(folderScanGroup.id)).resolves.toBe(false)

      expect(projectGroupsDelete).not.toHaveBeenCalled()
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
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

    it('removes contained projects only from the owner host', async () => {
      projectGroupsDelete.mockResolvedValue(true)
      const reposRemoveForHost = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('window', {
        api: {
          repos: { removeForHost: reposRemoveForHost },
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

  describe('createProjectGroup subgroup routing', () => {
    it('forwards parentGroupId to the owning runtime host RPC and adopts the subgroup', async () => {
      runtimeEnvironmentCall.mockResolvedValue({
        ok: true,
        result: {
          group: {
            ...folderScanGroup,
            id: 'sub-1',
            name: 'Subgroup',
            parentPath: null,
            parentGroupId: 'group-1',
            createdFrom: 'manual'
          }
        }
      })
      const store = createTestStore()

      await store
        .getState()
        .createProjectGroup('Subgroup', 'runtime:env-1', { parentGroupId: 'group-1' })

      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'env-1',
          method: 'projectGroup.create',
          params: { name: 'Subgroup', createdFrom: 'manual', parentGroupId: 'group-1' }
        })
      )
      expect(store.getState().projectGroups).toMatchObject([
        { id: 'sub-1', parentGroupId: 'group-1', executionHostId: 'runtime:env-1' }
      ])
    })

    it('forwards parentGroupId to local projectGroups.create IPC when creating a local subgroup', async () => {
      projectGroupsCreate.mockResolvedValue({
        ...folderScanGroup,
        id: 'local-sub',
        name: 'Local Subgroup',
        parentPath: null,
        parentGroupId: 'group-1',
        createdFrom: 'manual'
      })
      const store = createTestStore()

      await store
        .getState()
        .createProjectGroup('Local Subgroup', 'local', { parentGroupId: 'group-1' })

      expect(projectGroupsCreate).toHaveBeenCalledWith({
        name: 'Local Subgroup',
        createdFrom: 'manual',
        parentGroupId: 'group-1'
      })
      expect(store.getState().projectGroups).toMatchObject([
        { id: 'local-sub', parentGroupId: 'group-1', executionHostId: 'local' }
      ])
    })

    it('omits parentGroupId on wire when creating a root group with null or omitted parentGroupId', async () => {
      projectGroupsCreate.mockResolvedValue({
        ...folderScanGroup,
        id: 'local-root',
        name: 'Root Group',
        parentPath: null,
        parentGroupId: null,
        createdFrom: 'manual'
      })
      const store = createTestStore()

      await store.getState().createProjectGroup('Root Group', 'local', { parentGroupId: null })

      expect(projectGroupsCreate).toHaveBeenCalledWith({
        name: 'Root Group',
        createdFrom: 'manual'
      })
    })

    it('rejects subgroup creation and cleans up stray root group (including raced catalog pushes) when an older remote host drops parentGroupId', async () => {
      const store = createTestStore()
      const onParentMoveRejected = vi.fn()
      runtimeEnvironmentCall
        .mockResolvedValueOnce({
          ok: true,
          result: {
            group: {
              ...folderScanGroup,
              id: 'stray-root',
              name: 'Subgroup',
              parentPath: null,
              parentGroupId: null,
              createdFrom: 'manual'
            }
          }
        })
        .mockImplementationOnce(async () => {
          store.setState({
            projectGroups: [
              {
                ...folderScanGroup,
                id: 'stray-root',
                name: 'Subgroup',
                parentPath: null,
                parentGroupId: null,
                createdFrom: 'manual',
                executionHostId: 'runtime:env-1'
              }
            ]
          })
          return { ok: true, result: { deleted: true } }
        })

      const created = await store.getState().createProjectGroup('Subgroup', 'runtime:env-1', {
        parentGroupId: 'group-1',
        onParentMoveRejected
      })

      expect(created).toBeNull()
      expect(onParentMoveRejected).toHaveBeenCalledTimes(1)
      expect(store.getState().projectGroups).toEqual([])
      expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
      expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          selector: 'env-1',
          method: 'projectGroup.delete',
          params: { groupId: 'stray-root' }
        })
      )
    })

    it('forwards SSH connectionId when creating a group or subgroup on an ssh:<target> host', async () => {
      projectGroupsCreate.mockResolvedValue({
        ...folderScanGroup,
        id: 'ssh-sub',
        name: 'SSH Subgroup',
        connectionId: 'box-1',
        parentPath: null,
        parentGroupId: 'ssh-parent',
        createdFrom: 'manual'
      })
      const store = createTestStore()

      const created = await store
        .getState()
        .createProjectGroup('SSH Subgroup', 'ssh:box-1', { parentGroupId: 'ssh-parent' })

      expect(projectGroupsCreate).toHaveBeenCalledWith({
        name: 'SSH Subgroup',
        createdFrom: 'manual',
        connectionId: 'box-1',
        parentGroupId: 'ssh-parent'
      })
      expect(created?.executionHostId).toBe('ssh:box-1')
      expect(store.getState().projectGroups).toMatchObject([
        { id: 'ssh-sub', connectionId: 'box-1', executionHostId: 'ssh:box-1' }
      ])
    })

    it('retains the stray root group in store when older remote host drops parentGroupId and cleanup returns deleted: false or throws', async () => {
      const store = createTestStore()
      runtimeEnvironmentCall
        .mockResolvedValueOnce({
          ok: true,
          result: {
            group: {
              ...folderScanGroup,
              id: 'stray-kept',
              name: 'Subgroup',
              parentPath: null,
              parentGroupId: null,
              createdFrom: 'manual'
            }
          }
        })
        .mockResolvedValueOnce({ ok: true, result: { deleted: false } })

      const created = await store
        .getState()
        .createProjectGroup('Subgroup', 'runtime:env-1', { parentGroupId: 'group-1' })

      expect(created).toBeNull()
      expect(store.getState().projectGroups).toMatchObject([
        { id: 'stray-kept', parentGroupId: null, executionHostId: 'runtime:env-1' }
      ])

      runtimeEnvironmentCall
        .mockResolvedValueOnce({
          ok: true,
          result: {
            group: {
              ...folderScanGroup,
              id: 'stray-rejected-cleanup',
              name: 'Subgroup 2',
              parentPath: null,
              parentGroupId: null,
              createdFrom: 'manual'
            }
          }
        })
        .mockRejectedValueOnce(new Error('delete rpc failed'))

      const createdAfterRejectedCleanup = await store
        .getState()
        .createProjectGroup('Subgroup 2', 'runtime:env-1', { parentGroupId: 'group-1' })

      expect(createdAfterRejectedCleanup).toBeNull()
      expect(store.getState().projectGroups.map((entry) => entry.id)).toEqual([
        'stray-kept',
        'stray-rejected-cleanup'
      ])
    })
  })

  describe('updateProjectGroup reparenting', () => {
    it('commits parentGroupId before order fields on remote hosts so an older host rejecting parentGroupId never mutates tabOrder', async () => {
      const parentGroup: ProjectGroup = {
        ...folderScanGroup,
        id: 'parent-1',
        name: 'Parent',
        parentPath: null,
        createdFrom: 'manual',
        executionHostId: 'runtime:env-1'
      }
      const childCandidate: ProjectGroup = {
        ...parentGroup,
        id: 'child-1',
        name: 'Child',
        parentGroupId: null,
        tabOrder: 1
      }
      const store = createTestStore()
      store.setState({ projectGroups: [parentGroup, childCandidate] })

      // 1. Older remote host strips parentGroupId -> only parentGroupId was sent; tabOrder was never sent
      runtimeEnvironmentCall.mockResolvedValueOnce({
        ok: true,
        result: { group: { ...childCandidate, parentGroupId: null, tabOrder: 1 } }
      })
      const rejected = await store
        .getState()
        .updateProjectGroup('child-1', { parentGroupId: 'parent-1', tabOrder: 0 })
      expect(rejected).toBe(false)
      expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
      expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          method: 'projectGroup.update',
          params: { groupId: 'child-1', updates: { parentGroupId: 'parent-1' } }
        })
      )
      expect(store.getState().projectGroups.find((group) => group.id === 'child-1')).toMatchObject({
        parentGroupId: null,
        tabOrder: 1
      })

      // 2. Compatible remote host accepts parentGroupId first, then applies tabOrder
      runtimeEnvironmentCall.mockClear()
      runtimeEnvironmentCall
        .mockResolvedValueOnce({
          ok: true,
          result: { group: { ...childCandidate, parentGroupId: 'parent-1', tabOrder: 1 } }
        })
        .mockResolvedValueOnce({
          ok: true,
          result: { group: { ...childCandidate, parentGroupId: 'parent-1', tabOrder: 0 } }
        })
      const accepted = await store
        .getState()
        .updateProjectGroup('child-1', { parentGroupId: 'parent-1', tabOrder: 0 })
      expect(accepted).toBe(true)
      expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
      expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          method: 'projectGroup.update',
          params: { groupId: 'child-1', updates: { parentGroupId: 'parent-1' } }
        })
      )
      expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: 'projectGroup.update',
          params: { groupId: 'child-1', updates: { tabOrder: 0 } }
        })
      )
      expect(store.getState().projectGroups.find((group) => group.id === 'child-1')).toMatchObject({
        parentGroupId: 'parent-1',
        tabOrder: 0
      })
    })

    it('shows parent-move rejection toast when reparenting with rootProjectOrder against an older remote host lacking root-order capability', async () => {
      const toastErrorSpy = vi.spyOn(toast, 'error').mockImplementation(() => '')
      runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
        if (args.method === 'status.get') {
          const base = createCompatibleRuntimeStatusResponse()
          return Promise.resolve({
            ...base,
            result: { ...base.result, capabilities: [] }
          })
        }
        return runtimeEnvironmentCall(args)
      })
      const store = createTestStore()
      store.setState({
        projectGroups: [
          {
            ...folderScanGroup,
            id: 'sub-1',
            parentGroupId: 'group-1',
            executionHostId: 'runtime:env-1'
          }
        ]
      })

      const accepted = await store
        .getState()
        .updateProjectGroup('sub-1', { parentGroupId: null, tabOrder: 0, rootProjectOrder: 1000 })

      expect(accepted).toBe(false)
      expect(toastErrorSpy).toHaveBeenCalledTimes(1)
      toastErrorSpy.mockRestore()
    })

    it('reconciles committed parentGroupId into renderer state when the follow-up order stage or a sibling parent stage fails on a remote host', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const parentGroup: ProjectGroup = {
        ...folderScanGroup,
        id: 'parent-1',
        name: 'Parent',
        parentPath: null,
        createdFrom: 'manual',
        executionHostId: 'runtime:env-1'
      }
      const childCandidate: ProjectGroup = {
        ...parentGroup,
        id: 'child-1',
        name: 'Child',
        parentGroupId: null,
        tabOrder: 4
      }
      const childTwo: ProjectGroup = {
        ...parentGroup,
        id: 'child-2',
        name: 'Child 2',
        parentGroupId: null,
        tabOrder: 5
      }
      const store = createTestStore()
      store.setState({ projectGroups: [parentGroup, childCandidate, childTwo] })

      runtimeEnvironmentCall
        .mockResolvedValueOnce({
          ok: true,
          result: { group: { ...childCandidate, parentGroupId: 'parent-1', tabOrder: 4 } }
        })
        .mockRejectedValueOnce(new Error('network timeout on order stage'))

      const accepted = await store
        .getState()
        .updateProjectGroup('child-1', { parentGroupId: 'parent-1', tabOrder: 0 })

      expect(accepted).toBe(false)
      expect(store.getState().projectGroups.find((group) => group.id === 'child-1')).toMatchObject({
        parentGroupId: 'parent-1',
        tabOrder: 4,
        executionHostId: 'runtime:env-1'
      })

      runtimeEnvironmentCall.mockResolvedValueOnce({
        ok: true,
        result: {
          groups: [{ ...childTwo, parentGroupId: 'parent-1', tabOrder: 5 }]
        }
      })
      const batchAccepted = await store.getState().updateProjectGroups([
        {
          groupId: 'child-2',
          updates: { parentGroupId: 'parent-1', tabOrder: 1 },
          hostId: 'runtime:env-1'
        },
        {
          groupId: 'child-1',
          updates: { parentGroupId: null, tabOrder: 2 },
          hostId: 'runtime:env-1'
        }
      ])

      expect(batchAccepted).toBe(false)
      expect(store.getState().projectGroups.find((group) => group.id === 'child-2')).toMatchObject({
        parentGroupId: 'parent-1',
        tabOrder: 5,
        executionHostId: 'runtime:env-1'
      })
      consoleErrorSpy.mockRestore()
    })
  })
})
