import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { Repo } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  storeState: {
    repos: [] as Repo[],
    clearOrcaHookTrustForRepo: vi.fn(),
    openModal: vi.fn(),
    cancelNestedRepoScan: vi.fn()
  },
  addRemote: vi.fn(),
  onStateChanged: vi.fn(() => vi.fn()),
  fetchWorktrees: vi.fn(),
  onGitRepoReady: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    },
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

vi.mock('../../../../shared/nested-repo-telemetry', () => ({
  createNestedRepoTelemetryAttemptId: () => 'attempt-1'
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn()
  }
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-remote',
    path: '/srv/repo',
    displayName: 'remote-repo',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

describe('useRemoteRepo default-checkout handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.stateValues = [[], 'ssh-1', '/srv/repo', null, false, null]
    mocks.storeState.repos = []
    vi.stubGlobal('window', {
      api: {
        ssh: {
          onStateChanged: mocks.onStateChanged
        },
        repos: {
          addRemote: mocks.addRemote
        }
      }
    })
  })

  it('requests an authoritative worktree refresh before handoff', async () => {
    const repo = makeRepo()
    mocks.addRemote.mockResolvedValue({ repo })
    mocks.fetchWorktrees.mockResolvedValue(true)
    const { useRemoteRepo } = await import('./AddRepoSteps')

    const result = useRemoteRepo(
      mocks.fetchWorktrees,
      vi.fn(),
      vi.fn(),
      mocks.onGitRepoReady,
      vi.fn().mockResolvedValue(null)
    )
    await result.handleAddRemoteRepo()

    expect(mocks.addRemote).toHaveBeenCalledWith({
      connectionId: 'ssh-1',
      remotePath: '/srv/repo'
    })
    expect(mocks.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true
    })
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith(repo.id)
  })

  it('continues to completion when refresh is not authoritative after remote add', async () => {
    const repo = makeRepo()
    mocks.addRemote.mockResolvedValue({ repo })
    mocks.fetchWorktrees.mockResolvedValue(false)
    const { useRemoteRepo } = await import('./AddRepoSteps')

    const result = useRemoteRepo(
      mocks.fetchWorktrees,
      vi.fn(),
      vi.fn(),
      mocks.onGitRepoReady,
      vi.fn().mockResolvedValue(null)
    )
    await result.handleAddRemoteRepo()

    expect(mocks.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true
    })
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith(repo.id)
    expect(mocks.stateSetters[3]).not.toHaveBeenCalledWith(
      'Could not refresh project worktrees. Try again.'
    )
  })
})
