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
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/l',
  displayName: 'L',
  badgeColor: '#000',
  addedAt: 1
}
const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/r',
  displayName: 'R',
  badgeColor: '#000',
  addedAt: 1
}
const group = (id: string, parentPath: string): ProjectGroup => ({
  id,
  name: id,
  parentPath,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
})
const folder = (id: string, projectGroupId: string, folderPath: string): FolderWorkspace => ({
  id,
  projectGroupId,
  name: id,
  folderPath,
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
})
const localGroup = group('local-group', '/l')
const remoteGroup = group('remote-group', '/r')
const localFolder = folder('local-folder', 'local-group', '/l')
const remoteFolder = folder('remote-folder', 'remote-group', '/r')
const restoredFolderKey = folderWorkspaceKey('remote-folder')

const reposList = vi.fn()
const projectGroupsList = vi.fn()
const folderWorkspacesList = vi.fn()
const runtimeEnvironmentsList = vi.fn()
const runtimeEnvironmentCall = vi.fn()

function rpc(result: unknown): unknown {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'runtime-remote' } }
}

function remoteResult(method: string): unknown {
  switch (method) {
    case 'repo.list':
      return rpc({ repos: [remoteRepo] })
    case 'projectGroup.list':
      return rpc({ groups: [remoteGroup] })
    case 'folderWorkspace.list':
      return rpc({ folderWorkspaces: [remoteFolder] })
    case 'settings.get':
      return rpc({ settings: { worktreeVisibilityDefaults: { external: 'show' } } })
    default:
      return rpc({ projects: [], setups: [] })
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  for (const mock of [
    reposList,
    projectGroupsList,
    folderWorkspacesList,
    runtimeEnvironmentsList,
    runtimeEnvironmentCall
  ]) {
    mock.mockReset()
  }
  reposList.mockResolvedValue([localRepo])
  projectGroupsList.mockResolvedValue([localGroup])
  folderWorkspacesList.mockResolvedValue([localFolder])
  runtimeEnvironmentsList.mockResolvedValue([{ id: 'env-1', name: 'remote' }])
  runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
    remoteResult(args.method)
  )
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: {
        list: vi.fn().mockResolvedValue([]),
        listHostSetups: vi.fn().mockResolvedValue([])
      },
      projectGroups: { list: projectGroupsList },
      folderWorkspaces: { list: folderWorkspacesList },
      runtimeEnvironments: {
        list: runtimeEnvironmentsList,
        call: (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
      }
    },
    dispatchEvent: vi.fn()
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

function storeWithRestoredFolderOwner(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  store.setState({
    projectGroups: [
      { ...localGroup, executionHostId: 'local' },
      { ...remoteGroup, executionHostId: 'runtime:env-1' }
    ],
    restoredRuntimeHostIdByWorkspaceSessionKey: { [restoredFolderKey]: 'runtime:env-1' }
  })
  return store
}

describe('all-host folder workspace settlement', () => {
  it('drops a restored owner its own host settled even when the local catalog fails', async () => {
    folderWorkspacesList.mockRejectedValue(new Error('local down'))
    const store = storeWithRestoredFolderOwner()

    await store.getState().fetchFolderWorkspacesForAllHosts()

    expect(store.getState().folderWorkspaces.map((w) => w.id)).toEqual(['remote-folder'])
    expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({})
  })

  it('keeps restored folder owner hints and lists no runtimes when remote hosts are skipped', async () => {
    const store = storeWithRestoredFolderOwner()

    await store.getState().fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })
    await store.getState().fetchProjectGroupsForAllHosts({ remoteHosts: 'skip' })

    expect(runtimeEnvironmentsList).not.toHaveBeenCalled()
    expect(store.getState().folderWorkspaces.map((w) => w.id)).toEqual(['local-folder'])
    expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({
      [restoredFolderKey]: 'runtime:env-1'
    })
  })

  it('loads a folder-only catalog with no repos on any host', async () => {
    reposList.mockResolvedValue([])
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      args.method === 'repo.list' ? rpc({ repos: [] }) : remoteResult(args.method)
    )
    const store = createTestStore()
    store.setState({
      restoredRuntimeHostIdByWorkspaceSessionKey: { [restoredFolderKey]: 'runtime:env-1' }
    })

    await store.getState().fetchReposForAllHosts()
    await store.getState().fetchProjectGroupsForAllHosts()
    await store.getState().fetchFolderWorkspacesForAllHosts()

    expect(store.getState().repos).toEqual([])
    expect(store.getState().projectGroups.map((g) => g.id)).toEqual(['local-group', 'remote-group'])
    expect(store.getState().folderWorkspaces.map((w) => w.id)).toEqual([
      'local-folder',
      'remote-folder'
    ])
    expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({})
  })

  it('skips a runtime whose endpoint was removed during the load', async () => {
    const store = createTestStore()
    store.setState({ removedRuntimeEnvironmentIds: new Set(['env-1']) })

    await store.getState().fetchProjectGroupsForAllHosts()
    await store.getState().fetchFolderWorkspacesForAllHosts()
    await store.getState().fetchReposForAllHosts()

    expect(store.getState().projectGroups.map((g) => g.id)).toEqual(['local-group'])
    expect(store.getState().folderWorkspaces.map((w) => w.id)).toEqual(['local-folder'])
    expect(store.getState().repos.map((r) => r.id)).toEqual(['local-repo'])
    expect(store.getState().worktreeVisibilityDefaultsByHost['runtime:env-1']).toBeUndefined()
  })
})

describe('all-host repo settlement', () => {
  it('settles the local waiter with the error and still loads remote repos when local fails', async () => {
    const localError = new Error('local down')
    reposList.mockRejectedValue(localError)
    const store = createTestStore()

    await store.getState().fetchReposForAllHosts()

    await expect(store.getState().awaitLocalRepoCatalogSettlement()).rejects.toBe(localError)
    expect(store.getState().repos.map((r) => r.id)).toEqual(['remote-repo'])
  })

  it('applies visibility defaults but keeps saved filters when one remote repo catalog fails', async () => {
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        throw new Error('runtime_unreachable')
      }
      return remoteResult(args.method)
    })
    const store = createTestStore()
    store.setState({ activeRepoId: 'remote-repo', filterRepoIds: ['remote-repo'] })

    await store.getState().fetchReposForAllHosts()

    expect(store.getState().repos.map((r) => r.id)).toEqual(['local-repo'])
    expect(store.getState().worktreeVisibilityDefaultsByHost['runtime:env-1']).toEqual({
      external: 'show'
    })
    expect(store.getState().activeRepoId).toBe('remote-repo')
    expect(store.getState().filterRepoIds).toEqual(['remote-repo'])
  })
})
