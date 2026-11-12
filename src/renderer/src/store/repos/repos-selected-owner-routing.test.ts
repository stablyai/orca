import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'

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
})
