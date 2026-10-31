import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { Repo } from '../../../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  addRepoPath: vi.fn(),
  closeModal: vi.fn(),
  fetchWorktrees: vi.fn(),
  getNestedRepoRuntimeKind: vi.fn(),
  scanNestedRepos: vi.fn(),
  setActiveNestedScanId: vi.fn(),
  setNestedScanInProgress: vi.fn(),
  showNestedRepoReview: vi.fn(),
  onGitRepoReady: vi.fn(),
  setAddProjectBusyLabel: vi.fn(),
  markOnboardingProjectAdded: vi.fn(),
  track: vi.fn(),
  onWindowsDriveRefusal: vi.fn(),
  wslHostEnvironmentIds: new Set<string>()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useRef: <T>(value: T) => ({ current: value }),
    useState: <T>(initial: T | (() => T)) => {
      const index = mocks.stateIndex++
      const value =
        index in mocks.stateValues
          ? mocks.stateValues[index]
          : typeof initial === 'function'
            ? (initial as () => T)()
            : initial
      const setter = vi.fn()
      mocks.stateSetters[index] = setter
      return [value as T, setter]
    }
  }
})

vi.mock('@/lib/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: mocks.markOnboardingProjectAdded
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

vi.mock('@/lib/windows-path-access', () => ({
  getWindowsPathAccess: (hostId: string) =>
    [...mocks.wslHostEnvironmentIds].some((id) => hostId === `runtime:${id}`) ? {} : null
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'server-folder',
    path: '/server/docs',
    displayName: 'docs',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'folder',
    ...overrides
  }
}

describe('useAddRepoServerPathFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.stateValues = ['/server/docs', false]
    mocks.wslHostEnvironmentIds = new Set()
  })

  function renderFlow(activeRuntimeEnvironmentId: string) {
    return import('./useAddRepoServerPathFlow').then(({ useAddRepoServerPathFlow }) =>
      useAddRepoServerPathFlow({
        addRepoPath: mocks.addRepoPath,
        activeRuntimeEnvironmentId,
        closeModal: mocks.closeModal,
        fetchWorktrees: mocks.fetchWorktrees,
        getNestedRepoRuntimeKind: mocks.getNestedRepoRuntimeKind,
        scanNestedRepos: mocks.scanNestedRepos,
        setActiveNestedScanId: mocks.setActiveNestedScanId,
        setNestedScanInProgress: mocks.setNestedScanInProgress,
        showNestedRepoReview: mocks.showNestedRepoReview,
        onGitRepoReady: mocks.onGitRepoReady,
        setAddProjectBusyLabel: mocks.setAddProjectBusyLabel,
        onWindowsDriveRefusal: mocks.onWindowsDriveRefusal
      })
    )
  }

  it.each([
    ['  /mnt/c/Users/me/src  ', 'C:\\Users\\me\\src'],
    ['/mnt/C/x', 'C:\\x'],
    ['/home/me/../../mnt/d/./work/', 'D:\\work']
  ])('refuses typed %j on a WSL host inline, before scanning', async (typed, windowsPath) => {
    mocks.wslHostEnvironmentIds.add('wsl-env')
    mocks.stateValues = [typed, false]
    const flow = await renderFlow('wsl-env')
    await flow.handleAddServerPath('git')

    expect(mocks.scanNestedRepos).not.toHaveBeenCalled()
    expect(mocks.addRepoPath).not.toHaveBeenCalled()
    expect(mocks.onWindowsDriveRefusal).toHaveBeenCalledWith({
      kind: 'wsl_host_windows_drive_path',
      windowsPath
    })
  })

  it('lets a typed path that only passes through /mnt/<drive> reach the host', async () => {
    mocks.wslHostEnvironmentIds.add('wsl-env')
    mocks.stateValues = ['/mnt/c/../../home/me', false]
    mocks.addRepoPath.mockResolvedValue(makeRepo({ path: '/home/me' }))
    const flow = await renderFlow('wsl-env')
    await flow.handleAddServerPath('folder')
    expect(mocks.onWindowsDriveRefusal).not.toHaveBeenCalled()
    expect(mocks.addRepoPath).toHaveBeenCalled()
  })

  it('leaves /mnt/<drive> paths alone on SSH and paired hosts, and routes host refusals inline', async () => {
    mocks.stateValues = ['/mnt/c/src', false]
    mocks.addRepoPath.mockResolvedValue(makeRepo({ path: '/mnt/c/src' }))
    const flow = await renderFlow('ssh-env')
    await flow.handleAddServerPath('folder')

    expect(mocks.onWindowsDriveRefusal).not.toHaveBeenCalled()
    expect(mocks.addRepoPath).toHaveBeenCalledWith('/mnt/c/src', 'folder', {
      runtimeEnvironmentId: 'ssh-env',
      onWindowsDriveRefusal: mocks.onWindowsDriveRefusal
    })
  })

  it('marks onboarding folder progress before closing server folder adds', async () => {
    const repo = makeRepo()
    mocks.addRepoPath.mockResolvedValue(repo)
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    const result = useAddRepoServerPathFlow({
      addRepoPath: mocks.addRepoPath,
      activeRuntimeEnvironmentId: 'box1-environment-id',
      closeModal: mocks.closeModal,
      fetchWorktrees: mocks.fetchWorktrees,
      getNestedRepoRuntimeKind: mocks.getNestedRepoRuntimeKind,
      scanNestedRepos: mocks.scanNestedRepos,
      setActiveNestedScanId: mocks.setActiveNestedScanId,
      setNestedScanInProgress: mocks.setNestedScanInProgress,
      showNestedRepoReview: mocks.showNestedRepoReview,
      onGitRepoReady: mocks.onGitRepoReady,
      setAddProjectBusyLabel: mocks.setAddProjectBusyLabel,
      onWindowsDriveRefusal: mocks.onWindowsDriveRefusal
    })
    await result.handleAddServerPath('folder')

    expect(mocks.addRepoPath).toHaveBeenCalledWith('/server/docs', 'folder', {
      runtimeEnvironmentId: 'box1-environment-id',
      onWindowsDriveRefusal: mocks.onWindowsDriveRefusal
    })
    expect(mocks.scanNestedRepos).not.toHaveBeenCalled()
    expect(mocks.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.onGitRepoReady).not.toHaveBeenCalled()
    expect(mocks.markOnboardingProjectAdded).toHaveBeenCalledWith('addedFolder')
    expect(mocks.closeModal).toHaveBeenCalled()
  })

  it('routes the nested Git pre-scan and add through the selected runtime', async () => {
    const repo = makeRepo({ id: 'server-git', kind: 'git' })
    mocks.getNestedRepoRuntimeKind.mockReturnValue('runtime')
    mocks.scanNestedRepos.mockResolvedValue({
      selectedPath: '/server/docs',
      selectedPathKind: 'git_repo',
      repos: []
    })
    mocks.addRepoPath.mockResolvedValue(repo)
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    const result = useAddRepoServerPathFlow({
      addRepoPath: mocks.addRepoPath,
      activeRuntimeEnvironmentId: 'box1-environment-id',
      closeModal: mocks.closeModal,
      fetchWorktrees: mocks.fetchWorktrees,
      getNestedRepoRuntimeKind: mocks.getNestedRepoRuntimeKind,
      scanNestedRepos: mocks.scanNestedRepos,
      setActiveNestedScanId: mocks.setActiveNestedScanId,
      setNestedScanInProgress: mocks.setNestedScanInProgress,
      showNestedRepoReview: mocks.showNestedRepoReview,
      onGitRepoReady: mocks.onGitRepoReady,
      setAddProjectBusyLabel: mocks.setAddProjectBusyLabel,
      onWindowsDriveRefusal: mocks.onWindowsDriveRefusal
    })
    await result.handleAddServerPath('git')

    expect(mocks.scanNestedRepos).toHaveBeenCalledWith(
      '/server/docs',
      undefined,
      expect.objectContaining({ runtimeEnvironmentId: 'box1-environment-id' })
    )
    expect(mocks.addRepoPath).toHaveBeenCalledWith('/server/docs', 'git', {
      runtimeEnvironmentId: 'box1-environment-id',
      onWindowsDriveRefusal: mocks.onWindowsDriveRefusal
    })
    expect(mocks.fetchWorktrees).toHaveBeenCalledWith('server-git', {
      requireAuthoritative: true,
      executionHostId: 'runtime:box1-environment-id'
    })
  })
})
