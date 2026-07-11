import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { Repo } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  addRepo: vi.fn(),
  closeModal: vi.fn(),
  fetchWorktrees: vi.fn(),
  onGitRepoReady: vi.fn(),
  setAddProjectBusyLabel: vi.fn(),
  markOnboardingProjectAdded: vi.fn()
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

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'wsl-repo',
    path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\project',
    displayName: 'project',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

describe('useAddRepoWslFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    // [wslDistro, wslPath, wslError, isAddingWsl]
    mocks.stateValues = ['Ubuntu-24.04', '/home/user/project', null, false]
    vi.stubGlobal('window', {
      api: {
        repos: {
          add: mocks.addRepo
        }
      }
    })
  })

  it('submits repos.add with the {wsl:{distro,linuxPath}} shape', async () => {
    mocks.addRepo.mockResolvedValue({ repo: makeRepo() })
    mocks.fetchWorktrees.mockResolvedValue(true)
    const { useAddRepoWslFlow } = await import('./useAddRepoWslFlow')

    const result = useAddRepoWslFlow({
      closeModal: mocks.closeModal,
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady,
      setAddProjectBusyLabel: mocks.setAddProjectBusyLabel
    })
    await result.handleAddWsl('git')

    expect(mocks.addRepo).toHaveBeenCalledWith({
      wsl: { distro: 'Ubuntu-24.04', linuxPath: '/home/user/project' },
      kind: 'git'
    })
    expect(mocks.fetchWorktrees).toHaveBeenCalledWith('wsl-repo', { requireAuthoritative: true })
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith('wsl-repo', 'wsl_path')
  })

  it('completes folder adds without the git default-checkout handoff', async () => {
    mocks.addRepo.mockResolvedValue({ repo: makeRepo({ kind: 'folder' }) })
    const { useAddRepoWslFlow } = await import('./useAddRepoWslFlow')

    const result = useAddRepoWslFlow({
      closeModal: mocks.closeModal,
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady,
      setAddProjectBusyLabel: mocks.setAddProjectBusyLabel
    })
    await result.handleAddWsl('folder')

    expect(mocks.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.onGitRepoReady).not.toHaveBeenCalled()
    expect(mocks.markOnboardingProjectAdded).toHaveBeenCalledWith('addedFolder')
    expect(mocks.closeModal).toHaveBeenCalled()
  })

  it('surfaces the main-process error instead of completing the add', async () => {
    mocks.addRepo.mockResolvedValue({ error: 'Directory does not exist in WSL: /missing' })
    const { useAddRepoWslFlow } = await import('./useAddRepoWslFlow')

    const result = useAddRepoWslFlow({
      closeModal: mocks.closeModal,
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady,
      setAddProjectBusyLabel: mocks.setAddProjectBusyLabel
    })
    await result.handleAddWsl('git')

    expect(mocks.stateSetters[2]).toHaveBeenCalledWith('Directory does not exist in WSL: /missing')
    expect(mocks.closeModal).not.toHaveBeenCalled()
    expect(mocks.onGitRepoReady).not.toHaveBeenCalled()
  })

  it('does nothing when distro or path is blank', async () => {
    mocks.stateValues = ['', '/home/user/project', null, false]
    const { useAddRepoWslFlow } = await import('./useAddRepoWslFlow')

    const result = useAddRepoWslFlow({
      closeModal: mocks.closeModal,
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady,
      setAddProjectBusyLabel: mocks.setAddProjectBusyLabel
    })
    await result.handleAddWsl('git')

    expect(mocks.addRepo).not.toHaveBeenCalled()
  })
})
