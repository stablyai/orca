import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from './store-test-helpers'

const projectGroup: ProjectGroup = {
  id: 'group-runtime',
  name: 'Platform',
  parentPath: '/runtime/platform',
  parentGroupId: null,
  createdFrom: 'manual',
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

const reposList = vi.fn()
const projectGroupsList = vi.fn()
const projectGroupsImportNested = vi.fn()
const projectGroupsScanNested = vi.fn()
const projectGroupsCancelNestedScan = vi.fn()
const folderWorkspacesList = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projectGroups: {
        list: projectGroupsList,
        importNested: projectGroupsImportNested,
        scanNested: projectGroupsScanNested,
        cancelNestedScan: projectGroupsCancelNestedScan,
        onNestedScanProgress: vi.fn(() => vi.fn())
      },
      folderWorkspaces: { list: folderWorkspacesList },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('selected Add Project owner routing', () => {
  it('keeps a selected-runtime import refresh across an overlapping local refresh', async () => {
    const localRepo = { ...baseRepo, id: 'local-repo', path: '/local/repo' }
    const runtimeRepo = {
      ...baseRepo,
      id: 'runtime-repo',
      path: '/runtime/platform/api',
      projectGroupId: projectGroup.id
    }
    const result = {
      group: projectGroup,
      repos: [{ path: runtimeRepo.path, projectId: runtimeRepo.id, status: 'imported' as const }],
      importedCount: 1,
      alreadyKnownCount: 0,
      failedCount: 0
    }
    let resolveRuntimeRepos!: (value: unknown) => void
    const runtimeRepos = new Promise((resolve) => {
      resolveRuntimeRepos = resolve
    })
    runtimeEnvironmentCall.mockImplementation(({ method }) => {
      const responses: Record<string, unknown> = {
        'projectGroup.importNested': result,
        'projectGroup.list': { groups: [projectGroup] },
        'folderWorkspace.list': { folderWorkspaces: [] },
        'project.list': { projects: [] },
        'projectHostSetup.list': { setups: [] }
      }
      if (method === 'repo.list') {
        return runtimeRepos
      }
      return Promise.resolve({
        id: `rpc-${method}`,
        ok: true,
        result: responses[method],
        _meta: { runtimeId: 'runtime-remote' }
      })
    })
    reposList.mockResolvedValue([localRepo])
    const store = createTestStore()

    const importing = store.getState().importNestedRepos({
      parentPath: '/runtime/platform',
      groupName: 'Platform',
      projectPaths: [runtimeRepo.path],
      runtimeEnvironmentId: 'env-1',
      mode: 'group'
    })
    await vi.waitFor(() =>
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'repo.list', selector: 'env-1' })
      )
    )
    await store.getState().fetchRepos({ runtimeEnvironmentId: null })
    resolveRuntimeRepos({
      id: 'rpc-repos',
      ok: true,
      result: { repos: [runtimeRepo] },
      _meta: { runtimeId: 'runtime-remote' }
    })

    await expect(importing).resolves.toEqual(result)
    expect(store.getState().repos).toEqual(
      expect.arrayContaining([
        { ...localRepo, executionHostId: 'local' },
        { ...runtimeRepo, executionHostId: 'runtime:env-1' }
      ])
    )
  })

  it('drops older same-host group and folder responses that finish last', async () => {
    let resolveOldGroup!: (value: unknown) => void
    let resolveNewGroup!: (value: unknown) => void
    let resolveOldFolder!: (value: unknown) => void
    let resolveNewFolder!: (value: unknown) => void
    const groupResponses = [
      new Promise((resolve) => {
        resolveOldGroup = resolve
      }),
      new Promise((resolve) => {
        resolveNewGroup = resolve
      })
    ]
    const folderResponses = [
      new Promise((resolve) => {
        resolveOldFolder = resolve
      }),
      new Promise((resolve) => {
        resolveNewFolder = resolve
      })
    ]
    runtimeEnvironmentCall.mockImplementation(({ method }) => {
      if (method === 'projectGroup.list') {
        return groupResponses.shift()
      }
      if (method === 'folderWorkspace.list') {
        return folderResponses.shift()
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const store = createTestStore()
    const oldGroup = { ...projectGroup, id: 'group-old', parentPath: '/runtime/old' }
    const newGroup = { ...projectGroup, id: 'group-new', parentPath: '/runtime/new' }
    const oldFolder: FolderWorkspace = {
      id: 'old-folder',
      projectGroupId: oldGroup.id,
      name: 'Old folder',
      folderPath: '/runtime/old',
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
    const newFolder = {
      ...oldFolder,
      id: 'new-folder',
      projectGroupId: newGroup.id,
      name: 'New folder',
      folderPath: '/runtime/new'
    }

    const oldGroupsRequest = store.getState().fetchProjectGroups({ runtimeEnvironmentId: 'env-1' })
    const newGroupsRequest = store.getState().fetchProjectGroups({ runtimeEnvironmentId: 'env-1' })
    resolveNewGroup({
      id: 'rpc-new-group',
      ok: true,
      result: { groups: [newGroup] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await newGroupsRequest
    resolveOldGroup({
      id: 'rpc-old-group',
      ok: true,
      result: { groups: [oldGroup] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await oldGroupsRequest

    store.setState({
      projectGroups: [{ ...newGroup, executionHostId: 'runtime:env-1' }]
    })
    const oldFoldersRequest = store
      .getState()
      .fetchFolderWorkspaces({ runtimeEnvironmentId: 'env-1' })
    const newFoldersRequest = store
      .getState()
      .fetchFolderWorkspaces({ runtimeEnvironmentId: 'env-1' })
    resolveNewFolder({
      id: 'rpc-new-folder',
      ok: true,
      result: { folderWorkspaces: [newFolder] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await newFoldersRequest
    resolveOldFolder({
      id: 'rpc-old-folder',
      ok: true,
      result: { folderWorkspaces: [oldFolder] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await oldFoldersRequest

    expect(store.getState().projectGroups).toEqual([
      { ...newGroup, executionHostId: 'runtime:env-1' }
    ])
    expect(store.getState().folderWorkspaces).toEqual([
      { ...newFolder, executionHostId: 'runtime:env-1' }
    ])
  })

  it('drops pre-reconnect group and folder responses without pruning the new catalog', async () => {
    let resolveOldGroup!: (value: unknown) => void
    let resolveOldFolder!: (value: unknown) => void
    runtimeEnvironmentCall.mockImplementation(({ method }) => {
      if (method === 'projectGroup.list') {
        return new Promise((resolve) => {
          resolveOldGroup = resolve
        })
      }
      if (method === 'folderWorkspace.list') {
        return new Promise((resolve) => {
          resolveOldFolder = resolve
        })
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const store = createTestStore()
    store
      .getState()
      .setRuntimeEnvironments([{ id: 'env-1', createdAt: 1, pairingRevision: 1 } as never])
    const pending = store.getState().fetchProjectGroups({ runtimeEnvironmentId: 'env-1' })
    const pendingFolders = store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: 'env-1' })
    await vi.waitFor(() => expect(resolveOldGroup).toBeTypeOf('function'))
    await vi.waitFor(() => expect(resolveOldFolder).toBeTypeOf('function'))
    store
      .getState()
      .setRuntimeEnvironments([{ id: 'env-1', createdAt: 1, pairingRevision: 2 } as never])
    const newGroup = {
      ...projectGroup,
      id: 'group-after-reconnect',
      executionHostId: 'runtime:env-1'
    }
    const newFolder: FolderWorkspace = {
      id: 'folder-after-reconnect',
      projectGroupId: newGroup.id,
      name: 'New folder',
      folderPath: '/runtime/new',
      executionHostId: 'runtime:env-1',
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
    store.setState({ projectGroups: [newGroup], folderWorkspaces: [newFolder] })
    resolveOldGroup({
      id: 'rpc-before-reconnect',
      ok: true,
      result: { groups: [{ ...projectGroup, id: 'stale-group' }] },
      _meta: { runtimeId: 'runtime-old' }
    })
    resolveOldFolder({
      id: 'rpc-folder-before-reconnect',
      ok: true,
      result: {
        folderWorkspaces: [
          {
            ...newFolder,
            id: 'stale-folder',
            executionHostId: undefined
          }
        ]
      },
      _meta: { runtimeId: 'runtime-old' }
    })
    await pending
    await pendingFolders

    expect(store.getState().projectGroups).toEqual([newGroup])
    expect(store.getState().folderWorkspaces).toEqual([newFolder])
  })
})
