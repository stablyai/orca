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
