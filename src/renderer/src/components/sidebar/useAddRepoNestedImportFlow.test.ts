import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { NestedRepoScanResult, ProjectGroupImportResult, Repo } from '../../../../shared/types'

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useRef: <T>(value: T) => ({ current: value })
  }
})

const folderRepo: Repo = {
  id: 'platform',
  path: '/workspace/platform',
  displayName: 'platform',
  badgeColor: '#999999',
  addedAt: 1,
  kind: 'folder'
}

const mocks = vi.hoisted(() => ({
  state: {
    repos: [] as Repo[],
    addNonGitFolder: vi.fn(),
    closeModal: vi.fn(),
    openModal: vi.fn()
  }
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state
    }
  )
  return { useAppStore }
})

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn()
  }
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn()
}))

import { toast } from 'sonner'
import { track } from '@/lib/telemetry'
import { useAddRepoNestedImportFlow } from './useAddRepoNestedImportFlow'

const scan: NestedRepoScanResult = {
  selectedPath: '/workspace/platform',
  selectedPathKind: 'non_git_folder',
  repos: [{ path: '/workspace/platform/app', displayName: 'app', depth: 1 }],
  truncated: false,
  timedOut: false,
  stopped: false,
  durationMs: 3,
  maxDepth: 3,
  maxRepos: 100,
  timeoutMs: null
}

const gitRepo: Repo = {
  id: 'app',
  path: '/workspace/platform/app',
  displayName: 'app',
  badgeColor: '#999999',
  addedAt: 2,
  kind: 'git'
}

const groupImportResult: ProjectGroupImportResult = {
  group: {
    id: 'group-1',
    name: 'platform',
    parentPath: '/workspace/platform',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 3,
    updatedAt: 3
  },
  projects: [{ path: '/workspace/platform/app', projectId: 'app', status: 'imported' }],
  importedCount: 1,
  alreadyKnownCount: 0,
  failedCount: 0
}

const apiRepo: Repo = {
  id: 'api',
  path: '/workspace/platform/api',
  displayName: 'api',
  badgeColor: '#999999',
  addedAt: 2,
  kind: 'git'
}

const twoRepoScan: NestedRepoScanResult = {
  ...scan,
  repos: [
    { path: '/workspace/platform/app', displayName: 'app', depth: 1 },
    { path: '/workspace/platform/api', displayName: 'api', depth: 1 }
  ]
}

function useTestAddRepoNestedImportFlow(
  overrides: Partial<Parameters<typeof useAddRepoNestedImportFlow>[0]> = {}
): ReturnType<typeof useAddRepoNestedImportFlow> {
  return useAddRepoNestedImportFlow({
    nestedAttemptId: 'attempt-1',
    nestedScan: scan,
    nestedSelectedPaths: new Set(),
    nestedRuntimeKind: 'local',
    nestedConnectionId: null,
    nestedGroupName: 'platform',
    nestedImportScanId: 'scan-1',
    activeRuntimeEnvironmentId: null,
    closeModal: mocks.state.closeModal,
    fetchWorktrees: vi.fn(),
    importNestedRepos: vi.fn<() => Promise<ProjectGroupImportResult | null>>(),
    getNestedRepoRuntimeKind: vi.fn(() => 'local' as const),
    onGitRepoReady: vi.fn(),
    setIsAdding: vi.fn(),
    ...overrides
  })
}

describe('useAddRepoNestedImportFlow open folder fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.repos = []
    mocks.state.addNonGitFolder.mockResolvedValue(folderRepo)
  })

  it('opens the scanned local root through the existing non-git folder flow', async () => {
    const setIsAdding = vi.fn()
    const { handleOpenNestedRootFolder } = useTestAddRepoNestedImportFlow({ setIsAdding })

    await handleOpenNestedRootFolder()

    expect(mocks.state.addNonGitFolder).toHaveBeenCalledWith('/workspace/platform', {
      runtimeEnvironmentId: null
    })
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
    expect(setIsAdding).toHaveBeenNthCalledWith(1, true)
    expect(setIsAdding).toHaveBeenNthCalledWith(2, false)
  })

  it('keeps runtime folder opens on the runtime that produced the scan', async () => {
    const { handleOpenNestedRootFolder } = useTestAddRepoNestedImportFlow({
      activeRuntimeEnvironmentId: 'env-1'
    })

    await handleOpenNestedRootFolder()

    expect(mocks.state.addNonGitFolder).toHaveBeenCalledWith('/workspace/platform', {
      runtimeEnvironmentId: 'env-1'
    })
  })

  it('tracks the open-as-folder recovery action with zero selection', async () => {
    const { handleOpenNestedRootFolder } = useTestAddRepoNestedImportFlow()

    await handleOpenNestedRootFolder()

    expect(track).toHaveBeenCalledWith(
      'add_repo_nested_import_action',
      expect.objectContaining({
        action: 'open_as_folder',
        surface: 'sidebar',
        runtime_kind: 'local',
        found_count: 1,
        selected_count: 0
      })
    )
  })

  it('uses the existing SSH non-git folder confirmation for SSH scans', async () => {
    const { handleOpenNestedRootFolder } = useTestAddRepoNestedImportFlow({
      nestedConnectionId: 'ssh-builder',
      nestedRuntimeKind: 'ssh'
    })

    await handleOpenNestedRootFolder()

    expect(mocks.state.addNonGitFolder).not.toHaveBeenCalled()
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.state.openModal).toHaveBeenCalledWith('confirm-non-git-folder', {
      folderPath: '/workspace/platform',
      connectionId: 'ssh-builder'
    })
  })
})

describe('useAddRepoNestedImportFlow grouped import handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.repos = [gitRepo]
  })

  it('carries the created group into the handoff so the group stays the target', async () => {
    const onGitRepoReady = vi.fn()
    const { handleImportNestedRepos } = useTestAddRepoNestedImportFlow({
      nestedSelectedPaths: new Set(['/workspace/platform/app']),
      importNestedRepos: vi.fn(() => Promise.resolve(groupImportResult)),
      onGitRepoReady
    })

    await handleImportNestedRepos('group')

    expect(onGitRepoReady).toHaveBeenCalledWith('app', 'local_folder_picker', {
      importedProjectGroupId: 'group-1'
    })
  })

  it('reveals every imported member and hands off the first repo in scan order', async () => {
    const onGitRepoReady = vi.fn()
    const fetchWorktrees = vi.fn()
    const importNestedRepos = vi.fn(() =>
      Promise.resolve({
        ...groupImportResult,
        projects: [
          { path: '/workspace/platform/app', projectId: 'app', status: 'imported' as const },
          { path: '/workspace/platform/api', projectId: 'api', status: 'imported' as const }
        ],
        importedCount: 2
      })
    )
    mocks.state.repos = [gitRepo, apiRepo]
    const { handleImportNestedRepos } = useTestAddRepoNestedImportFlow({
      nestedScan: twoRepoScan,
      // Why: Set insertion order is deliberately reversed — the handoff must
      // follow the scan order users reviewed, not selection order.
      nestedSelectedPaths: new Set(['/workspace/platform/api', '/workspace/platform/app']),
      importNestedRepos,
      fetchWorktrees,
      onGitRepoReady
    })

    await handleImportNestedRepos('group')

    expect(importNestedRepos).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPaths: ['/workspace/platform/app', '/workspace/platform/api']
      })
    )
    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(fetchWorktrees).toHaveBeenCalledWith('app', { requireAuthoritative: true })
    expect(fetchWorktrees).toHaveBeenCalledWith('api', { requireAuthoritative: true })
    expect(onGitRepoReady).toHaveBeenCalledTimes(1)
    expect(onGitRepoReady).toHaveBeenCalledWith('app', 'local_folder_picker', {
      importedProjectGroupId: 'group-1'
    })
  })

  it('keeps the group as the handoff target when part of the import fails', async () => {
    const onGitRepoReady = vi.fn()
    const { handleImportNestedRepos } = useTestAddRepoNestedImportFlow({
      nestedScan: twoRepoScan,
      nestedSelectedPaths: new Set(['/workspace/platform/app', '/workspace/platform/api']),
      importNestedRepos: vi.fn(() =>
        Promise.resolve({
          ...groupImportResult,
          projects: [
            { path: '/workspace/platform/app', projectId: 'app', status: 'imported' as const },
            { path: '/workspace/platform/api', status: 'failed' as const, error: 'clone failed' }
          ],
          failedCount: 1
        })
      ),
      onGitRepoReady
    })

    await handleImportNestedRepos('group')

    // Why: the group still exists with its surviving member, so a partial
    // failure warns without downgrading the target to a lone project.
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(onGitRepoReady).toHaveBeenCalledWith('app', 'local_folder_picker', {
      importedProjectGroupId: 'group-1'
    })
  })

  it('never reaches the handoff when every import fails', async () => {
    const onGitRepoReady = vi.fn()
    const { handleImportNestedRepos } = useTestAddRepoNestedImportFlow({
      nestedSelectedPaths: new Set(['/workspace/platform/app']),
      importNestedRepos: vi.fn(() =>
        Promise.resolve({
          ...groupImportResult,
          projects: [
            { path: '/workspace/platform/app', status: 'failed' as const, error: 'clone failed' }
          ],
          importedCount: 0,
          failedCount: 1
        })
      ),
      onGitRepoReady
    })

    await handleImportNestedRepos('group')

    // Why: with zero imported repos the flow surfaces the first failure and
    // stops, so composer group selection can never see an all-failed import.
    expect(toast.error).toHaveBeenCalledWith(expect.any(String), { description: 'clone failed' })
    expect(onGitRepoReady).not.toHaveBeenCalled()
  })

  it('carries no group for separate imports, which create none', async () => {
    const onGitRepoReady = vi.fn()
    const { handleImportNestedRepos } = useTestAddRepoNestedImportFlow({
      nestedSelectedPaths: new Set(['/workspace/platform/app']),
      importNestedRepos: vi.fn(() => Promise.resolve({ ...groupImportResult, group: undefined })),
      onGitRepoReady
    })

    await handleImportNestedRepos('separate')

    expect(onGitRepoReady).toHaveBeenCalledWith('app', 'local_folder_picker', {
      importedProjectGroupId: undefined
    })
  })
})
