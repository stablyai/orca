import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../slices/store-test-helpers'

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
        repos: {},
        projectGroups: { update: projectGroupsUpdate, delete: projectGroupsDelete },
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
})
