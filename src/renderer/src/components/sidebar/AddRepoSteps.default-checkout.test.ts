import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { Repo } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  storeState: {
    repos: [] as Repo[],
    projects: [],
    projectHostSetups: [],
    clearOrcaHookTrustForRepo: vi.fn(),
    openModal: vi.fn(),
    cancelNestedRepoScan: vi.fn()
  },
  addRemote: vi.fn(),
  listTargets: vi.fn(),
  getState: vi.fn(),
  runtimeRpc: vi.fn(),
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

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.runtimeRpc
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
    mocks.storeState.projects = []
    mocks.storeState.projectHostSetups = []
    mocks.listTargets.mockResolvedValue([
      { id: 'ssh-1', label: 'Builder 1' },
      { id: 'ssh-2', label: 'Builder 2' }
    ])
    mocks.getState.mockResolvedValue({ status: 'connected' })
    mocks.runtimeRpc.mockReset()
    vi.stubGlobal('window', {
      api: {
        ssh: {
          listTargets: mocks.listTargets,
          getState: mocks.getState,
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
    expect(mocks.storeState.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceRepoIds: [repo.id] })])
    )
    expect(mocks.storeState.projectHostSetups).toEqual(
      expect.arrayContaining([expect.objectContaining({ repoId: repo.id, path: repo.path })])
    )
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

  it('preselects the preferred SSH target when opening Browse for a selected host', async () => {
    mocks.stateValues = [[], null, '~/', null, false, null]
    const { useRemoteRepo } = await import('./AddRepoSteps')

    const result = useRemoteRepo(
      mocks.fetchWorktrees,
      vi.fn(),
      vi.fn(),
      mocks.onGitRepoReady,
      vi.fn().mockResolvedValue(null)
    )
    await result.handleOpenRemoteStep('ssh-2')

    expect(mocks.listTargets).toHaveBeenCalled()
    expect(mocks.getState).toHaveBeenCalledWith({ targetId: 'ssh-1' })
    expect(mocks.getState).toHaveBeenCalledWith({ targetId: 'ssh-2' })
    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('ssh-2')
  })

  it('loads SSH targets from the selected runtime server', async () => {
    mocks.stateValues = [[], null, '~/', null, false, null]
    mocks.runtimeRpc.mockImplementation(
      (_target: unknown, method: string, params?: { targetId?: string }) => {
        if (method === 'ssh.listTargets') {
          return Promise.resolve({ targets: [{ id: 'ssh-p8', label: 'p8' }] })
        }
        if (method === 'ssh.getState') {
          return Promise.resolve({
            state: {
              targetId: params?.targetId,
              status: 'connected',
              error: null,
              reconnectAttempt: 0
            }
          })
        }
        throw new Error(`Unexpected method: ${method}`)
      }
    )
    const { useRemoteRepo } = await import('./AddRepoSteps')

    const result = useRemoteRepo(
      mocks.fetchWorktrees,
      vi.fn(),
      vi.fn(),
      mocks.onGitRepoReady,
      vi.fn().mockResolvedValue(null),
      undefined,
      undefined,
      'env-linux'
    )
    await result.handleOpenRemoteStep('ssh-p8')

    expect(mocks.runtimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-linux' },
      'ssh.listTargets'
    )
    expect(mocks.runtimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-linux' },
      'ssh.getState',
      { targetId: 'ssh-p8' }
    )
    expect(mocks.listTargets).not.toHaveBeenCalled()
    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('ssh-p8')
  })

  it('adds an SSH project through the selected runtime server', async () => {
    const repo = makeRepo({ connectionId: 'ssh-p8', executionHostId: 'runtime:env-linux' })
    mocks.stateValues = [[], 'ssh-p8', '/srv/repo', null, false, null]
    mocks.runtimeRpc.mockResolvedValue({ repo })
    mocks.fetchWorktrees.mockResolvedValue(true)
    const { useRemoteRepo } = await import('./AddRepoSteps')

    const result = useRemoteRepo(
      mocks.fetchWorktrees,
      vi.fn(),
      vi.fn(),
      mocks.onGitRepoReady,
      vi.fn().mockResolvedValue(null),
      undefined,
      undefined,
      'env-linux'
    )
    await result.handleAddRemoteRepo()

    expect(mocks.runtimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-linux' },
      'repo.addRemote',
      { connectionId: 'ssh-p8', remotePath: '/srv/repo' }
    )
    expect(mocks.addRemote).not.toHaveBeenCalled()
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith(repo.id)
  })
})
