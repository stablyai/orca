import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { NestedRepoScanResult, Repo } from '../../../../shared/types'
import type { useAddRepoServerPathFlow } from './useAddRepoServerPathFlow'

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
  track: vi.fn()
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

function makeScan(overrides: Partial<NestedRepoScanResult> = {}): NestedRepoScanResult {
  return {
    selectedPath: '/server/docs',
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

function flowDeps(
  runtimeEnvironmentId: string | null
): Parameters<typeof useAddRepoServerPathFlow>[0] {
  return {
    addRepoPath: mocks.addRepoPath,
    closeModal: mocks.closeModal,
    fetchWorktrees: mocks.fetchWorktrees,
    getNestedRepoRuntimeKind: mocks.getNestedRepoRuntimeKind,
    runtimeEnvironmentId,
    scanNestedRepos: mocks.scanNestedRepos,
    setActiveNestedScanId: mocks.setActiveNestedScanId,
    setNestedScanInProgress: mocks.setNestedScanInProgress,
    showNestedRepoReview: mocks.showNestedRepoReview,
    onGitRepoReady: mocks.onGitRepoReady,
    setAddProjectBusyLabel: mocks.setAddProjectBusyLabel
  }
}

describe('useAddRepoServerPathFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.stateValues = ['/server/docs', false]
    mocks.getNestedRepoRuntimeKind.mockReturnValue('local')
  })

  it('marks onboarding folder progress before closing server folder adds', async () => {
    const repo = makeRepo()
    mocks.addRepoPath.mockResolvedValue(repo)
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    const result = useAddRepoServerPathFlow(flowDeps(null))
    await result.handleAddServerPath('folder')

    expect(mocks.addRepoPath).toHaveBeenCalledWith('/server/docs', 'folder', {
      runtimeEnvironmentId: null
    })
    expect(mocks.scanNestedRepos).not.toHaveBeenCalled()
    expect(mocks.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.onGitRepoReady).not.toHaveBeenCalled()
    expect(mocks.markOnboardingProjectAdded).toHaveBeenCalledWith('addedFolder')
    expect(mocks.closeModal).toHaveBeenCalled()
  })

  // Why: the host path was browsed on the dialog's selected server, so adding it
  // against the globally focused runtime registers it on the wrong filesystem and
  // only fails later, when a terminal spawns into a cwd that does not exist.
  it('routes folder adds to the host selected in the dialog', async () => {
    mocks.addRepoPath.mockResolvedValue(makeRepo())
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    await useAddRepoServerPathFlow(flowDeps('env-1')).handleAddServerPath('folder')

    expect(mocks.addRepoPath).toHaveBeenCalledWith('/server/docs', 'folder', {
      runtimeEnvironmentId: 'env-1'
    })
  })

  it('routes host-path git scans and adds to the host selected in the dialog', async () => {
    const repo = makeRepo({ id: 'server-git', kind: 'git' })
    mocks.getNestedRepoRuntimeKind.mockReturnValue('runtime')
    mocks.scanNestedRepos.mockResolvedValue(makeScan())
    mocks.addRepoPath.mockResolvedValue(repo)
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    await useAddRepoServerPathFlow(flowDeps('env-1')).handleAddServerPath('git')

    expect(mocks.scanNestedRepos).toHaveBeenCalledWith('/server/docs', undefined, undefined, {
      runtimeEnvironmentId: 'env-1'
    })
    expect(mocks.addRepoPath).toHaveBeenCalledWith('/server/docs', 'git', {
      runtimeEnvironmentId: 'env-1'
    })
    expect(mocks.fetchWorktrees).toHaveBeenCalledWith('server-git', { requireAuthoritative: true })
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith('server-git', 'runtime_server_path')
  })
})
