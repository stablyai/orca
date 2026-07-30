import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/srv/repo',
  displayName: 'Remote',
  badgeColor: '#000',
  addedAt: 1
}

const localProjectGroup: ProjectGroup = {
  id: 'local-group',
  name: 'Local group',
  parentPath: '/local',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const remoteProjectGroup: ProjectGroup = {
  id: 'remote-group',
  name: 'Remote group',
  parentPath: '/srv',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const localFolderWorkspace: FolderWorkspace = {
  id: 'local-folder',
  projectGroupId: 'local-group',
  name: 'Local folder',
  folderPath: '/local',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

const remoteFolderWorkspace: FolderWorkspace = {
  id: 'remote-folder',
  projectGroupId: 'remote-group',
  name: 'Remote folder',
  folderPath: '/srv',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

const reposList = vi.fn()
const projectsList = vi.fn()
const listHostSetups = vi.fn()
const projectGroupsList = vi.fn()
const folderWorkspacesList = vi.fn()
const runtimeEnvironmentsList = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const dispatchEventMock = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset()
  projectsList.mockReset()
  listHostSetups.mockReset()
  projectGroupsList.mockReset()
  folderWorkspacesList.mockReset()
  runtimeEnvironmentsList.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  dispatchEventMock.mockReset()

  reposList.mockResolvedValue([localRepo])
  projectsList.mockResolvedValue([])
  listHostSetups.mockResolvedValue([])
  projectGroupsList.mockResolvedValue([localProjectGroup])
  folderWorkspacesList.mockResolvedValue([localFolderWorkspace])
  runtimeEnvironmentsList.mockResolvedValue([{ id: 'env-1', name: 'lobster' }])
  runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    if (args.method === 'repo.list') {
      return {
        id: 'rpc-repo-list',
        ok: true,
        result: { repos: [remoteRepo] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    if (args.method === 'projectGroup.list') {
      return {
        id: 'rpc-project-group-list',
        ok: true,
        result: { groups: [remoteProjectGroup] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    if (args.method === 'folderWorkspace.list') {
      return {
        id: 'rpc-folder-workspace-list',
        ok: true,
        result: { folderWorkspaces: [remoteFolderWorkspace] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    return {
      id: 'rpc-other',
      ok: true,
      result: { projects: [], setups: [] },
      _meta: { runtimeId: 'runtime-remote' }
    }
  })
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })

  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: { list: projectsList, listHostSetups },
      projectGroups: { list: projectGroupsList },
      folderWorkspaces: { list: folderWorkspacesList },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCall,
        list: runtimeEnvironmentsList
      }
    },
    dispatchEvent: dispatchEventMock
  })
})

describe('all-host folder workspace startup catalogs', () => {
  it('loads project groups and folder workspaces for every host', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })
    const restoredFolderKey = folderWorkspaceKey('remote-folder')
    store.setState({
      restoredRuntimeHostIdByWorkspaceSessionKey: {
        [restoredFolderKey]: 'runtime:env-1',
        'remote-repo::/srv/repo': 'runtime:env-1'
      }
    })

    await store.getState().fetchProjectGroupsForAllHosts()
    await store.getState().fetchFolderWorkspacesForAllHosts()

    expect(store.getState().projectGroups).toEqual([
      { ...localProjectGroup, executionHostId: 'local' },
      { ...remoteProjectGroup, executionHostId: 'runtime:env-1' }
    ])
    expect(store.getState().folderWorkspaces.map((workspace) => workspace.id)).toEqual([
      'local-folder',
      'remote-folder'
    ])
    expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({
      'remote-repo::/srv/repo': 'runtime:env-1'
    })

    const missingGroupStore = createTestStore()
    missingGroupStore.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projectGroups: [localProjectGroup],
      restoredRuntimeHostIdByWorkspaceSessionKey: { [restoredFolderKey]: 'runtime:env-1' }
    })
    await missingGroupStore.getState().fetchFolderWorkspacesForAllHosts()

    expect(missingGroupStore.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({
      [restoredFolderKey]: 'runtime:env-1'
    })
  })

  it('accumulates folder catalogs from concurrent runtime hosts', async () => {
    const secondRemoteGroup: ProjectGroup = {
      ...remoteProjectGroup,
      id: 'remote-group-2',
      executionHostId: 'runtime:env-2'
    }
    const secondRemoteFolder: FolderWorkspace = {
      ...remoteFolderWorkspace,
      id: 'remote-folder-2',
      projectGroupId: secondRemoteGroup.id
    }
    runtimeEnvironmentsList.mockResolvedValue([
      { id: 'env-1', name: 'lobster' },
      { id: 'env-2', name: 'shrimp' }
    ])
    runtimeEnvironmentCall.mockImplementation(
      (args: RuntimeEnvironmentCallRequest & { selector: string }) => {
        if (args.method === 'folderWorkspace.list') {
          const folderWorkspaces =
            args.selector === 'env-2' ? [secondRemoteFolder] : [remoteFolderWorkspace]
          return {
            id: `rpc-folder-workspace-list-${args.selector}`,
            ok: true,
            result: { folderWorkspaces },
            _meta: { runtimeId: `runtime-${args.selector}` }
          }
        }
        return {
          id: `rpc-other-${args.selector}`,
          ok: true,
          result: { projects: [], setups: [] },
          _meta: { runtimeId: `runtime-${args.selector}` }
        }
      }
    )
    const store = createTestStore()
    store.setState({
      projectGroups: [
        { ...localProjectGroup, executionHostId: 'local' },
        { ...remoteProjectGroup, executionHostId: 'runtime:env-1' },
        secondRemoteGroup
      ]
    })

    await store.getState().fetchFolderWorkspacesForAllHosts()

    expect(
      store
        .getState()
        .folderWorkspaces.map((workspace) => workspace.id)
        .sort()
    ).toEqual(['local-folder', 'remote-folder', 'remote-folder-2'])
  })

  it('keeps local project groups and folder workspaces when a runtime is unreachable', async () => {
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'projectGroup.list' || args.method === 'folderWorkspace.list') {
        throw new Error('runtime_unreachable')
      }
      return {
        id: 'rpc-other',
        ok: true,
        result: { repos: [], projects: [], setups: [] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchProjectGroupsForAllHosts()
    await store.getState().fetchFolderWorkspacesForAllHosts()

    expect(store.getState().projectGroups).toEqual([
      { ...localProjectGroup, executionHostId: 'local' }
    ])
    expect(store.getState().folderWorkspaces).toEqual([localFolderWorkspace])
  })

  it('does not repeat offline runtime compatibility probes across startup catalog loads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtimeEnvironmentTransportCall.mockResolvedValue({
      id: 'status',
      ok: false,
      error: { code: 'runtime_unavailable', message: 'offline' },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })
    const restoredFolderKey = folderWorkspaceKey('remote-folder')
    store.setState({
      restoredRuntimeHostIdByWorkspaceSessionKey: {
        [restoredFolderKey]: 'runtime:env-1'
      }
    })

    try {
      await store.getState().fetchReposForAllHosts()
      await store.getState().fetchProjectGroupsForAllHosts()
      await store.getState().fetchFolderWorkspacesForAllHosts()

      expect(store.getState().repos).toEqual([{ ...localRepo, executionHostId: 'local' }])
      expect(store.getState().projectGroups).toEqual([
        { ...localProjectGroup, executionHostId: 'local' }
      ])
      expect(store.getState().folderWorkspaces).toEqual([localFolderWorkspace])
      expect(runtimeEnvironmentTransportCall.mock.calls.map((call) => call[0].method)).toEqual([
        'status.get'
      ])
      expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({
        [restoredFolderKey]: 'runtime:env-1'
      })
    } finally {
      warn.mockRestore()
    }
  })
})
