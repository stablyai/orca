import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

const projectGroupsImportNested = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const importArgs = {
  parentPath: '/srv/projects',
  groupName: 'Projects',
  projectPaths: ['/srv/projects/api'],
  mode: 'group' as const
}

const importResult = { projects: [], importedCount: 0, alreadyKnownCount: 0, failedCount: 0 }

function stubHostRefresh(
  store: ReturnType<typeof createTestStore>
): Record<string, ReturnType<typeof vi.fn>> {
  const refreshes = {
    fetchProjectGroups: vi.fn().mockResolvedValue(undefined),
    fetchFolderWorkspaces: vi.fn().mockResolvedValue(undefined),
    fetchRepos: vi.fn().mockResolvedValue(undefined),
    fetchProjectGroupsForAllHosts: vi.fn().mockResolvedValue(undefined),
    fetchFolderWorkspacesForAllHosts: vi.fn().mockResolvedValue(undefined),
    fetchReposForAllHosts: vi.fn().mockResolvedValue(undefined)
  }
  store.setState(refreshes as never)
  return refreshes
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  projectGroupsImportNested.mockReset()
  projectGroupsImportNested.mockResolvedValue(importResult)
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      projectGroups: { importNested: projectGroupsImportNested },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

// Why: the Add Project dialog scans the host picked in its own selector, so the
// import that follows must land on that host and not on the focused runtime (#6367).
describe('nested repo import host routing', () => {
  it('imports on the caller-provided host and rehydrates every host', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-import',
      ok: true,
      result: importResult,
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    const refreshes = stubHostRefresh(store)

    await expect(
      store.getState().importNestedRepos(importArgs, { runtimeEnvironmentId: 'env-1' })
    ).resolves.toEqual(importResult)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.importNested',
      params: {
        parentPath: '/srv/projects',
        groupName: 'Projects',
        projectPaths: ['/srv/projects/api'],
        scanId: undefined,
        mode: 'group'
      },
      timeoutMs: 60_000
    })
    expect(projectGroupsImportNested).not.toHaveBeenCalled()
    // Why: single-host hydration replaces the catalogs with the focused host's slice,
    // which would drop the projects the import just created on the other host.
    expect(refreshes.fetchReposForAllHosts).toHaveBeenCalled()
    expect(refreshes.fetchProjectGroupsForAllHosts).toHaveBeenCalled()
    expect(refreshes.fetchFolderWorkspacesForAllHosts).toHaveBeenCalled()
    expect(refreshes.fetchRepos).not.toHaveBeenCalled()
  })

  it('keeps a caller-local import local while a runtime is focused', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })
    const refreshes = stubHostRefresh(store)

    await store.getState().importNestedRepos(importArgs, { runtimeEnvironmentId: null })

    expect(projectGroupsImportNested).toHaveBeenCalledWith(importArgs)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(refreshes.fetchReposForAllHosts).toHaveBeenCalled()
  })

  it('rehydrates only the focused host when the import stays on it', async () => {
    const store = createTestStore()
    const refreshes = stubHostRefresh(store)

    await store.getState().importNestedRepos(importArgs)

    expect(projectGroupsImportNested).toHaveBeenCalledWith(importArgs)
    expect(refreshes.fetchRepos).toHaveBeenCalled()
    expect(refreshes.fetchReposForAllHosts).not.toHaveBeenCalled()
  })
})
