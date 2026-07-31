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
const projectGroupsScanNested = vi.fn()
const projectGroupsCancelNestedScan = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const importArgs = {
  parentPath: '/srv/projects',
  groupName: 'Projects',
  projectPaths: ['/srv/projects/api'],
  mode: 'group' as const
}

const importResult = { projects: [], importedCount: 0, alreadyKnownCount: 0, failedCount: 0 }

const scanResult = {
  selectedPath: '/srv/projects',
  selectedPathKind: 'non_git_folder' as const,
  repos: []
}

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
  projectGroupsScanNested.mockReset()
  projectGroupsScanNested.mockResolvedValue(scanResult)
  projectGroupsCancelNestedScan.mockReset()
  projectGroupsCancelNestedScan.mockResolvedValue(true)
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      projectGroups: {
        importNested: projectGroupsImportNested,
        scanNested: projectGroupsScanNested,
        cancelNestedScan: projectGroupsCancelNestedScan
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

// Why: the Add Project dialog picks its own host, so scan, cancel, and import all
// have to follow that choice rather than the globally focused runtime (#6367).
describe('nested repo scan host routing', () => {
  it('scans on the caller-provided host instead of the focused runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-scan',
      ok: true,
      result: scanResult,
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()

    await store
      .getState()
      .scanNestedRepos('/srv/projects', undefined, undefined, { runtimeEnvironmentId: 'env-1' })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.scanNested',
      params: { path: '/srv/projects' },
      timeoutMs: 20_000
    })
    expect(projectGroupsScanNested).not.toHaveBeenCalled()
  })

  it('keeps a caller-local scan local while a runtime is focused', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store
      .getState()
      .scanNestedRepos('/srv/projects', undefined, undefined, { runtimeEnvironmentId: null })

    expect(projectGroupsScanNested).toHaveBeenCalledWith({
      path: '/srv/projects',
      connectionId: undefined,
      scanId: undefined
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  // Why: the runtime RPC has no connectionId field, so a focused runtime capturing
  // an SSH request would silently read the runtime's own filesystem instead.
  it('keeps SSH scans on local IPC no matter which runtime is focused', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().scanNestedRepos('/srv/projects', 'ssh-1')
    await store
      .getState()
      .scanNestedRepos('/srv/projects', 'ssh-1', undefined, { runtimeEnvironmentId: 'env-1' })

    expect(projectGroupsScanNested).toHaveBeenCalledTimes(2)
    expect(projectGroupsScanNested).toHaveBeenLastCalledWith({
      path: '/srv/projects',
      connectionId: 'ssh-1',
      scanId: undefined
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  // Why: only local scans stream and can be stopped; resolving cancel against the
  // focused runtime instead of the scan's host makes Stop a silent no-op.
  it('cancels on the host the scan was routed to', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await expect(
      store.getState().cancelNestedRepoScan('scan-1', { runtimeEnvironmentId: null })
    ).resolves.toBe(true)
    await expect(
      store.getState().cancelNestedRepoScan('scan-1', { runtimeEnvironmentId: 'env-1' })
    ).resolves.toBe(false)

    expect(projectGroupsCancelNestedScan).toHaveBeenCalledTimes(1)
    expect(projectGroupsCancelNestedScan).toHaveBeenCalledWith({ scanId: 'scan-1' })
  })
})

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

  // Why: the runtime RPC has no connectionId field, so a focused runtime capturing
  // an SSH import would silently retarget it at the runtime's own filesystem.
  it('keeps SSH imports on local IPC no matter which runtime is focused', async () => {
    const sshArgs = { ...importArgs, connectionId: 'ssh-builder' }
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })
    stubHostRefresh(store)

    await store.getState().importNestedRepos(sshArgs)
    await store.getState().importNestedRepos(sshArgs, { runtimeEnvironmentId: 'env-1' })

    expect(projectGroupsImportNested).toHaveBeenNthCalledWith(1, sshArgs)
    expect(projectGroupsImportNested).toHaveBeenNthCalledWith(2, sshArgs)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
