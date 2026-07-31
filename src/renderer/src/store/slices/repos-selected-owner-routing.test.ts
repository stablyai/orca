import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
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
  it('merges explicit runtime groups and folders without erasing local siblings', async () => {
    const localGroup = { ...projectGroup, id: 'group-local', executionHostId: 'local' as const }
    const runtimeGroup = { ...projectGroup, name: 'Runtime' }
    const localFolder: FolderWorkspace = {
      id: 'folder-local',
      projectGroupId: localGroup.id,
      name: 'Local folder',
      folderPath: '/local/folder',
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
    const runtimeFolder = {
      ...localFolder,
      id: 'folder-runtime',
      projectGroupId: runtimeGroup.id,
      name: 'Runtime folder',
      folderPath: '/runtime/folder'
    }
    runtimeEnvironmentCall.mockImplementation(async ({ method }) =>
      method === 'projectGroup.list'
        ? {
            id: 'rpc-groups',
            ok: true,
            result: { groups: [runtimeGroup] },
            _meta: { runtimeId: 'runtime-remote' }
          }
        : {
            id: 'rpc-folders',
            ok: true,
            result: { folderWorkspaces: [runtimeFolder] },
            _meta: { runtimeId: 'runtime-remote' }
          }
    )
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-ambient' } as never,
      projectGroups: [localGroup],
      folderWorkspaces: [localFolder]
    })

    await store.getState().fetchProjectGroups({ runtimeEnvironmentId: 'env-1' })
    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: 'env-1' })

    expect(store.getState().projectGroups).toEqual([
      localGroup,
      { ...runtimeGroup, executionHostId: 'runtime:env-1' }
    ])
    expect(store.getState().folderWorkspaces).toEqual([localFolder, runtimeFolder])

    projectGroupsList.mockResolvedValue([localGroup])
    folderWorkspacesList.mockResolvedValue([localFolder])
    store.setState({ settings: { activeRuntimeEnvironmentId: null } as never })
    await store.getState().fetchProjectGroups()
    await store.getState().fetchFolderWorkspaces()

    expect(store.getState().projectGroups).toEqual([
      localGroup,
      { ...runtimeGroup, executionHostId: 'runtime:env-1' }
    ])
    expect(store.getState().folderWorkspaces).toEqual([localFolder, runtimeFolder])
  })

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

  it('pins selected SSH scans and cancellation to local IPC over an ambient runtime', async () => {
    const scan = {
      selectedPath: '/srv/platform',
      selectedPathKind: 'git_repo' as const,
      repos: [],
      truncated: false,
      timedOut: false,
      stopped: false,
      durationMs: 1,
      maxDepth: 3,
      maxRepos: 100,
      timeoutMs: null
    }
    projectGroupsScanNested.mockResolvedValue(scan)
    projectGroupsCancelNestedScan.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-ambient' } as never })

    await expect(
      store.getState().scanNestedRepos('/srv/platform', 'ssh-1', {
        scanId: 'scan-ssh',
        runtimeEnvironmentId: null
      })
    ).resolves.toEqual(scan)
    await expect(
      store.getState().cancelNestedRepoScan('scan-ssh', { runtimeEnvironmentId: null })
    ).resolves.toBe(true)

    expect(projectGroupsScanNested).toHaveBeenCalledWith({
      path: '/srv/platform',
      connectionId: 'ssh-1',
      scanId: 'scan-ssh'
    })
    expect(projectGroupsCancelNestedScan).toHaveBeenCalledWith({ scanId: 'scan-ssh' })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
