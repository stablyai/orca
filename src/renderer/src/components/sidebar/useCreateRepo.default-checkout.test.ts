import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { Repo } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  storeState: {
    settings: { activeRuntimeEnvironmentId: null as string | null },
    repos: [] as Repo[],
    worktreesByRepo: {} as Record<string, unknown[]>
  },
  createRepo: vi.fn(),
  fetchWorktrees: vi.fn(),
  onGitRepoReady: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
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

vi.mock('@/hooks/useMountedRef', () => ({
  useMountedRef: () => ({ current: true })
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: mocks.markOnboardingProjectAdded
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
    {
      getState: () => mocks.storeState,
      setState: (next: Partial<typeof mocks.storeState>) => {
        Object.assign(mocks.storeState, next)
      }
    }
  )
  return { useAppStore }
})

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn()
  }
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-created',
    path: '/projects/created',
    displayName: 'created',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

describe('useCreateRepo default-checkout handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.stateValues = ['created', '/projects', null, false]
    mocks.storeState.repos = []
    mocks.storeState.worktreesByRepo = {}
    mocks.storeState.settings.activeRuntimeEnvironmentId = null
    vi.stubGlobal('window', {
      api: {
        repos: {
          create: mocks.createRepo,
          pickDirectory: vi.fn()
        }
      }
    })
  })

  it('requests an authoritative worktree refresh before handoff', async () => {
    const repo = makeRepo()
    mocks.createRepo.mockResolvedValue({ repo })
    mocks.fetchWorktrees.mockResolvedValue(true)
    const { useCreateRepo } = await import('./useCreateRepo')

    const result = useCreateRepo(mocks.fetchWorktrees, vi.fn(), mocks.onGitRepoReady)
    await result.handleCreate()

    expect(mocks.createRepo).toHaveBeenCalledWith({
      parentPath: '/projects',
      name: 'created',
      kind: 'git'
    })
    expect(mocks.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true
    })
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith(repo.id)
  })

  it('returns the selected parent directory after the local picker applies it', async () => {
    const pickedDir = '/Users/alice/custom-projects'
    vi.mocked(window.api.repos.pickDirectory).mockResolvedValue(pickedDir)
    const { useCreateRepo } = await import('./useCreateRepo')

    const result = useCreateRepo(mocks.fetchWorktrees, vi.fn(), mocks.onGitRepoReady)
    await expect(result.handlePickParent()).resolves.toBe(pickedDir)

    expect(mocks.stateSetters[1]).toHaveBeenCalledWith(pickedDir)
  })

  it('does not return a parent path when the runtime target blocks the local picker', async () => {
    mocks.storeState.settings.activeRuntimeEnvironmentId = 'env-1'
    const { useCreateRepo } = await import('./useCreateRepo')

    const result = useCreateRepo(mocks.fetchWorktrees, vi.fn(), mocks.onGitRepoReady)
    await expect(result.handlePickParent()).resolves.toBeNull()

    expect(window.api.repos.pickDirectory).not.toHaveBeenCalled()
    expect(mocks.stateSetters[1]).not.toHaveBeenCalled()
  })

  it('continues to completion when refresh is not authoritative after create', async () => {
    const repo = makeRepo()
    mocks.createRepo.mockResolvedValue({ repo })
    mocks.fetchWorktrees.mockResolvedValue(false)
    const { useCreateRepo } = await import('./useCreateRepo')

    const result = useCreateRepo(mocks.fetchWorktrees, vi.fn(), mocks.onGitRepoReady)
    await result.handleCreate()

    expect(mocks.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true
    })
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith(repo.id)
    expect(mocks.stateSetters[3]).not.toHaveBeenCalledWith(
      'Could not refresh project worktrees. Try again.'
    )
  })

  it('uses the folder completion path if IPC returns a folder project', async () => {
    const repo = makeRepo({ kind: 'folder' })
    const worktree = { id: `${repo.id}::/projects/created` }
    const closeModal = vi.fn()
    mocks.stateValues = ['created', '/projects', null, false]
    mocks.createRepo.mockResolvedValue({ repo })
    mocks.fetchWorktrees.mockImplementation(async (repoId: string) => {
      mocks.storeState.worktreesByRepo = { [repoId]: [worktree] }
      return true
    })
    const { useCreateRepo } = await import('./useCreateRepo')

    const result = useCreateRepo(mocks.fetchWorktrees, closeModal, mocks.onGitRepoReady)
    await result.handleCreate()

    expect(mocks.createRepo).toHaveBeenCalledWith({
      parentPath: '/projects',
      name: 'created',
      kind: 'git'
    })
    expect(mocks.fetchWorktrees).toHaveBeenCalledWith(repo.id)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(worktree.id, {
      sidebarRevealBehavior: 'auto'
    })
    expect(mocks.markOnboardingProjectAdded).toHaveBeenCalledWith('addedFolder')
    expect(closeModal).toHaveBeenCalled()
    expect(mocks.onGitRepoReady).not.toHaveBeenCalled()
  })
})
