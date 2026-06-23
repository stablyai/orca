import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type {
  FolderWorkspace,
  Project,
  ProjectHostSetup,
  ProjectGroup,
  Repo
} from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

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

const localProject: Project = {
  id: 'local-project',
  displayName: 'Local project',
  badgeColor: '#000',
  sourceRepoIds: ['local-repo'],
  createdAt: 1,
  updatedAt: 1
}

const localProjectHostSetup: ProjectHostSetup = {
  id: 'local-setup',
  projectId: 'local-project',
  hostId: 'local',
  repoId: 'local-repo',
  path: '/local',
  displayName: 'Local setup',
  setupState: 'setting-up',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1
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
  projectsList.mockResolvedValue([localProject])
  listHostSetups.mockResolvedValue([localProjectHostSetup])
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
      projects: { list: projectsList, listHostSetups: listHostSetups },
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

describe('fetchReposForAllHosts', () => {
  it('loads local + all configured runtime environments even when a remote env is active', async () => {
    // Why: a cold start that restored a remote workspace leaves the remote
    // environment active. The active-host-only fetchRepos would drop local
    // repos entirely; fetchReposForAllHosts must surface both.
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()

    const ids = store
      .getState()
      .repos.map((repo) => repo.id)
      .sort()
    expect(ids).toEqual(['local-repo', 'remote-repo'])
    expect(store.getState().projects).toContainEqual(localProject)
    expect(store.getState().projectHostSetups).toContainEqual(localProjectHostSetup)
  })

  it('fails soft when a runtime environment is unreachable, keeping local repos', async () => {
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        throw new Error('runtime_unreachable')
      }
      return {
        id: 'rpc-other',
        ok: true,
        result: { projects: [], setups: [] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()

    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo'])
  })

  it('loads project groups and folder workspaces for every host', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

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
})
