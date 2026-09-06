import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { Repo } from '../../../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  refValues: [] as unknown[],
  refIndex: 0,
  /** Every ref object the hook created, in creation order, so a test can supersede a flow mid-run. */
  createdRefs: [] as { current: unknown }[],
  storeState: {
    settings: { activeRuntimeEnvironmentId: null as string | null },
    repos: [] as Repo[],
    projects: [],
    projectHostSetups: []
  },
  cloneRemote: vi.fn(),
  cloneLocal: vi.fn(),
  pickDirectory: vi.fn(),
  onCloneProgress: vi.fn(() => vi.fn()),
  callRuntimeRpc: vi.fn(),
  fetchWorktrees: vi.fn(),
  onGitRepoReady: vi.fn(),
  resolveIntake: vi.fn(() => Promise.resolve({ outcome: 'not-applicable' })),
  decide: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    },
    useRef: <T>(value: T) => {
      const index = mocks.refIndex++
      const ref = {
        current: index in mocks.refValues ? (mocks.refValues[index] as T) : value
      }
      mocks.createdRefs.push(ref as { current: unknown })
      return ref
    },
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

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' }),
  callRuntimeRpc: mocks.callRuntimeRpc
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-cloned',
    path: '/srv/orca',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

describe('useAddRepoCloneFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.refIndex = 0
    mocks.refValues = []
    mocks.createdRefs = []
    mocks.stateValues = ['https://github.com/stablyai/orca.git', '/srv', false, null, null]
    mocks.storeState.repos = []
    mocks.storeState.projects = []
    mocks.storeState.projectHostSetups = []
    vi.stubGlobal('window', {
      api: {
        repos: {
          cloneRemote: mocks.cloneRemote,
          clone: mocks.cloneLocal,
          pickDirectory: mocks.pickDirectory,
          onCloneProgress: mocks.onCloneProgress
        },
        workspaceTrust: { resolveIntake: mocks.resolveIntake, decide: mocks.decide }
      }
    })
  })

  it('clones through the selected SSH target', async () => {
    const repo = makeRepo({ connectionId: 'ssh-1' })
    mocks.cloneRemote.mockResolvedValue(repo)
    mocks.callRuntimeRpc.mockReset()
    mocks.fetchWorktrees.mockResolvedValue(true)
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      sshTargetId: 'ssh-1',
      workspaceDir: '/local/workspace',
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady
    })
    await result.handleClone()

    expect(mocks.cloneRemote).toHaveBeenCalledWith({
      connectionId: 'ssh-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/srv'
    })
    expect(mocks.cloneLocal).not.toHaveBeenCalled()
    expect(mocks.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true,
      executionHostId: 'ssh:ssh-1'
    })
    expect(mocks.storeState.repos).toContainEqual({
      ...repo,
      executionHostId: 'ssh:ssh-1'
    })
    expect(mocks.storeState.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceRepoIds: [repo.id] })])
    )
    expect(mocks.storeState.projectHostSetups).toEqual(
      expect.arrayContaining([expect.objectContaining({ repoId: repo.id, path: repo.path })])
    )
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith(repo.id, 'clone_url', 'ssh:ssh-1')
    // Why: an SSH-hosted repo has no local filesystem root to gate.
    expect(mocks.resolveIntake).not.toHaveBeenCalled()
  })

  it('does not prefill SSH clone destinations from the local workspace directory', async () => {
    mocks.stateValues = ['https://github.com/stablyai/orca.git', '', false, null, null]
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      sshTargetId: 'ssh-1',
      workspaceDir: '/private/tmp/orca-setup-e2e.hOWO1f',
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady
    })

    expect(result.cloneDestination).toBe('')
    expect(mocks.stateSetters[1]).not.toHaveBeenCalledWith('/private/tmp/orca-setup-e2e.hOWO1f')
  })

  it('strips Electron IPC wrappers from clone errors', async () => {
    const cloneError =
      'Clone failed: Destination already exists and is not empty: /srv/orca. Choose a different parent folder, delete the existing folder, or add the existing repository instead.'
    mocks.cloneRemote.mockRejectedValue(
      new Error(`Error invoking remote method 'repos:cloneRemote': Error: ${cloneError}`)
    )
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      sshTargetId: 'ssh-1',
      workspaceDir: '/local/workspace',
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady
    })
    await result.handleClone()

    expect(mocks.stateSetters[3]).toHaveBeenCalledWith(cloneError)
  })

  it('clones through the selected runtime environment', async () => {
    const repo = makeRepo({ id: 'runtime-repo' })
    const localRepo = makeRepo({
      id: repo.id,
      path: '/local/runtime-repo',
      executionHostId: 'local'
    })
    mocks.storeState.repos = [localRepo]
    mocks.callRuntimeRpc.mockResolvedValue({ repo })
    mocks.fetchWorktrees.mockResolvedValue(true)
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: 'env-1',
      sshTargetId: null,
      workspaceDir: '/local/workspace',
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady
    })
    await result.handleClone()

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'repo.clone',
      {
        url: 'https://github.com/stablyai/orca.git',
        destination: '/srv'
      },
      { timeoutMs: 10 * 60_000 }
    )
    expect(mocks.cloneLocal).not.toHaveBeenCalled()
    expect(mocks.cloneRemote).not.toHaveBeenCalled()
    expect(mocks.fetchWorktrees).toHaveBeenCalledWith(repo.id, {
      requireAuthoritative: true,
      executionHostId: 'runtime:env-1'
    })
    expect(mocks.storeState.repos).toContainEqual({
      ...repo,
      executionHostId: 'runtime:env-1'
    })
    expect(mocks.storeState.repos).toContainEqual(localRepo)
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith(repo.id, 'clone_url', 'runtime:env-1')
    // Why: a runtime-hosted repo has no local filesystem root to gate.
    expect(mocks.resolveIntake).not.toHaveBeenCalled()
  })

  it('resolves workspace trust for a fully local clone, after the fetch completes', async () => {
    const repo = makeRepo()
    mocks.cloneLocal.mockResolvedValue(repo)
    // Why: 'not-applicable' avoids needing an `openModal` stub here — the prompt
    // itself is fully covered by ensure-workspace-trust-confirmed.test.ts; this
    // test only proves the call site passes the right target.
    mocks.resolveIntake.mockResolvedValue({ outcome: 'not-applicable' })
    mocks.fetchWorktrees.mockResolvedValue(true)
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      sshTargetId: null,
      workspaceDir: '/local/workspace',
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady
    })
    await result.handleClone()

    expect(mocks.resolveIntake).toHaveBeenCalledWith({
      target: { kind: 'repo', repoId: repo.id }
    })
    // Why the order matters: a refresh that fails reports a failed clone, and a
    // trust decision already written would outlive the failure it belongs to.
    expect(mocks.resolveIntake.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mocks.fetchWorktrees.mock.invocationCallOrder[0]!
    )
  })

  // Why: the user abandoned or superseded this flow. Writing a trust decision for
  // a workspace they walked away from is a decision they never confirmed.
  it('records no trust decision when the flow is superseded during the worktree refresh', async () => {
    const repo = makeRepo()
    mocks.cloneLocal.mockResolvedValue(repo)
    mocks.resolveIntake.mockResolvedValue({ outcome: 'not-applicable' })
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      sshTargetId: null,
      workspaceDir: '/local/workspace',
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady
    })
    // The second ref the hook creates is the monotonic clone generation; bumping it
    // mid-refresh is exactly what starting or resetting another clone does.
    const cloneGenRef = mocks.createdRefs[1] as { current: number }
    mocks.fetchWorktrees.mockImplementation(async () => {
      cloneGenRef.current += 1
      return true
    })
    await result.handleClone()

    expect(mocks.fetchWorktrees).toHaveBeenCalled()
    expect(mocks.resolveIntake).not.toHaveBeenCalled()
    expect(mocks.onGitRepoReady).not.toHaveBeenCalled()
  })
})
