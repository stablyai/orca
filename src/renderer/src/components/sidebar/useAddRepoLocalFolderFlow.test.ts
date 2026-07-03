import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { NestedRepoScanResult, Repo } from '../../../../shared/types'

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useEffect: vi.fn(),
    useRef: <T>(value: T) => ({ current: value })
  }
})

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn()
  }
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn()
}))

function makeScan(
  path: string,
  overrides: Partial<NestedRepoScanResult> = {}
): NestedRepoScanResult {
  return {
    selectedPath: path,
    selectedPathKind: 'git_repo',
    repos: [],
    truncated: false,
    timedOut: false,
    stopped: false,
    durationMs: 1,
    maxDepth: 3,
    maxRepos: 100,
    timeoutMs: null,
    ...overrides
  }
}

function makeRepo(path: string): Repo {
  const id = path.split('/').pop() ?? path
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git'
  }
}

describe('useAddRepoLocalFolderFlow', () => {
  const addRepoPath = vi.fn()
  const closeModal = vi.fn()
  const fetchWorktrees = vi.fn()
  const scanNestedRepos = vi.fn()
  const setActiveNestedScanId = vi.fn()
  const setNestedScanInProgress = vi.fn()
  const showNestedRepoReview = vi.fn()
  const onGitRepoReady = vi.fn()
  const setIsAdding = vi.fn()
  const setAddProjectBusyLabel = vi.fn()
  const pickFolders = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: {
        repos: {
          pickFolders
        }
      }
    })
    addRepoPath.mockImplementation(async (path: string) => makeRepo(path))
    fetchWorktrees.mockResolvedValue(true)
    scanNestedRepos.mockImplementation(async (path: string) => makeScan(path))
    onGitRepoReady.mockResolvedValue(undefined)
  })

  it('adds every selected local folder and completes one default-checkout handoff', async () => {
    pickFolders.mockResolvedValue(['/projects/alpha', '/projects/beta'])
    const { useAddRepoLocalFolderFlow } = await import('./useAddRepoLocalFolderFlow')

    const { handleBrowse } = useAddRepoLocalFolderFlow({
      isOpen: true,
      droppedLocalPath: '',
      activeRuntimeEnvironmentId: null,
      addRepoPath,
      closeModal,
      fetchWorktrees,
      scanNestedRepos,
      setActiveNestedScanId,
      setNestedScanInProgress,
      showNestedRepoReview,
      onGitRepoReady,
      setIsAdding,
      setAddProjectBusyLabel
    })

    await handleBrowse()

    expect(pickFolders).toHaveBeenCalledTimes(1)
    expect(addRepoPath).toHaveBeenCalledTimes(2)
    expect(addRepoPath).toHaveBeenNthCalledWith(1, '/projects/alpha')
    expect(addRepoPath).toHaveBeenNthCalledWith(2, '/projects/beta')
    expect(fetchWorktrees).toHaveBeenCalledWith('alpha', { requireAuthoritative: true })
    expect(fetchWorktrees).toHaveBeenCalledWith('beta', { requireAuthoritative: true })
    expect(onGitRepoReady).toHaveBeenCalledTimes(1)
    expect(onGitRepoReady).toHaveBeenCalledWith('alpha', 'local_folder_picker')
  })

  it('skips nested-review folders in a multi-folder add and continues with git folders', async () => {
    pickFolders.mockResolvedValue(['/projects/monorepo', '/projects/later'])
    scanNestedRepos.mockImplementationOnce(async (_path, _connectionId, controls) => {
      const scan = makeScan('/projects/monorepo', {
        selectedPathKind: 'non_git_folder',
        repos: [{ path: '/projects/monorepo/app', displayName: 'app', depth: 1 }]
      })
      controls?.onProgress?.(scan)
      return scan
    })
    const { useAddRepoLocalFolderFlow } = await import('./useAddRepoLocalFolderFlow')

    const { handleBrowse } = useAddRepoLocalFolderFlow({
      isOpen: true,
      droppedLocalPath: '',
      activeRuntimeEnvironmentId: null,
      addRepoPath,
      closeModal,
      fetchWorktrees,
      scanNestedRepos,
      setActiveNestedScanId,
      setNestedScanInProgress,
      showNestedRepoReview,
      onGitRepoReady,
      setIsAdding,
      setAddProjectBusyLabel
    })

    await handleBrowse()

    expect(showNestedRepoReview).not.toHaveBeenCalled()
    expect(addRepoPath).toHaveBeenCalledTimes(1)
    expect(addRepoPath).toHaveBeenCalledWith('/projects/later')
    expect(scanNestedRepos).toHaveBeenCalledTimes(2)
    expect(onGitRepoReady).toHaveBeenCalledWith('later', 'local_folder_picker')
  })

  it('still completes handoff when a later selected folder is skipped', async () => {
    pickFolders.mockResolvedValue(['/projects/git', '/projects/monorepo'])
    scanNestedRepos.mockResolvedValueOnce(makeScan('/projects/git')).mockResolvedValueOnce(
      makeScan('/projects/monorepo', {
        selectedPathKind: 'non_git_folder',
        repos: [{ path: '/projects/monorepo/app', displayName: 'app', depth: 1 }]
      })
    )
    const { useAddRepoLocalFolderFlow } = await import('./useAddRepoLocalFolderFlow')

    const { handleBrowse } = useAddRepoLocalFolderFlow({
      isOpen: true,
      droppedLocalPath: '',
      activeRuntimeEnvironmentId: null,
      addRepoPath,
      closeModal,
      fetchWorktrees,
      scanNestedRepos,
      setActiveNestedScanId,
      setNestedScanInProgress,
      showNestedRepoReview,
      onGitRepoReady,
      setIsAdding,
      setAddProjectBusyLabel
    })

    await handleBrowse()

    expect(showNestedRepoReview).not.toHaveBeenCalled()
    expect(addRepoPath).toHaveBeenCalledTimes(1)
    expect(addRepoPath).toHaveBeenCalledWith('/projects/git')
    expect(onGitRepoReady).toHaveBeenCalledWith('git', 'local_folder_picker')
  })
})
