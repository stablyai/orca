import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { Repo } from '../../../../shared/repo-types'
import type { RepositoryAddScriptPreview } from '../../../../shared/repository-add-script-types'

const addScriptMocks = vi.hoisted(() => ({
  resolveRequest: vi.fn(),
  offer: vi.fn()
}))

vi.mock('@/runtime/runtime-repository-add-script', () => ({
  resolveRuntimeRepositoryAddScriptRequest: addScriptMocks.resolveRequest
}))

vi.mock('@/store/repository-add-script-prompt', () => ({
  offerRepositoryAddScript: addScriptMocks.offer
}))

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  refValues: [] as unknown[],
  refIndex: 0,
  storeState: {
    settings: { activeRuntimeEnvironmentId: null as string | null },
    repos: [] as Repo[],
    projects: [],
    projectHostSetups: []
  },
  cloneLocal: vi.fn(),
  pickDirectory: vi.fn(),
  onCloneProgress: vi.fn(() => vi.fn()),
  callRuntimeRpc: vi.fn(),
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
    useRef: <T>(value: T) => {
      const index = mocks.refIndex++
      return {
        current: index in mocks.refValues ? (mocks.refValues[index] as T) : value
      }
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

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

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

function makePreview(
  overrides: Partial<RepositoryAddScriptPreview> = {}
): RepositoryAddScriptPreview {
  return {
    token: 'token-cloned',
    hostId: 'local',
    hostLabel: 'This computer',
    repoId: 'repo-cloned',
    path: '/srv',
    target: { kind: 'native', cwd: '/srv' },
    script: 'echo cloned',
    scriptHash: 'hash-cloned',
    ...overrides
  }
}

describe('useAddRepoCloneFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    addScriptMocks.resolveRequest.mockResolvedValue(undefined)
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.refIndex = 0
    mocks.refValues = []
    mocks.stateValues = ['https://github.com/stablyai/orca.git', '/srv', false, null, null]
    mocks.storeState.repos = []
    mocks.storeState.projects = []
    mocks.storeState.projectHostSetups = []
    vi.stubGlobal('window', {
      api: {
        repos: {
          clone: mocks.cloneLocal,
          pickDirectory: mocks.pickDirectory,
          onCloneProgress: mocks.onCloneProgress
        }
      }
    })
  })

  it('strips Electron IPC wrappers from clone errors', async () => {
    const cloneError =
      'Clone failed: Destination already exists and is not empty: /srv/orca. Choose a different parent folder, delete the existing folder, or add the existing repository instead.'
    mocks.cloneLocal.mockRejectedValue(
      new Error(`Error invoking remote method 'repos:clone': Error: ${cloneError}`)
    )
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
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
  })

  it('clones without the opt-in and never offers when the host does not accept one', async () => {
    const repo = makeRepo()
    mocks.cloneLocal.mockResolvedValue(repo)
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      workspaceDir: '/local/workspace',
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady
    })
    await result.handleClone()

    expect(mocks.cloneLocal).toHaveBeenCalledWith({
      url: 'https://github.com/stablyai/orca.git',
      destination: '/srv'
    })
    expect(addScriptMocks.offer).not.toHaveBeenCalled()
  })

  it('opts the local clone in and offers a matching preview once', async () => {
    const repo = makeRepo()
    const preview = makePreview()
    addScriptMocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.cloneLocal.mockResolvedValue({ repo, repositoryAddScriptPreview: preview })
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      workspaceDir: '/local/workspace',
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady
    })
    await result.handleClone()

    expect(mocks.cloneLocal).toHaveBeenCalledWith({
      url: 'https://github.com/stablyai/orca.git',
      destination: '/srv',
      repositoryAddScriptPreview: { hostId: 'local' }
    })
    expect(addScriptMocks.offer).toHaveBeenCalledTimes(1)
    expect(addScriptMocks.offer).toHaveBeenCalledWith(preview)
  })

  it('does not offer a preview addressed to another host', async () => {
    const repo = makeRepo()
    addScriptMocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.cloneLocal.mockResolvedValue({
      repo,
      repositoryAddScriptPreview: makePreview({ hostId: 'runtime:env-1' })
    })
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      workspaceDir: '/local/workspace',
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady
    })
    await result.handleClone()

    expect(addScriptMocks.offer).not.toHaveBeenCalled()
  })

  it('still offers a preview the host minted when a catalog refresh already stored the row', async () => {
    const repo = makeRepo()
    const preview = makePreview()
    addScriptMocks.resolveRequest.mockResolvedValue({ hostId: 'local' })
    mocks.cloneLocal.mockResolvedValue({
      repo,
      repositoryAddScriptPreview: preview
    })
    mocks.storeState.repos = [{ ...repo, executionHostId: 'local' }]
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: null,
      workspaceDir: '/local/workspace',
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady
    })
    await result.handleClone()

    expect(addScriptMocks.offer).toHaveBeenCalledWith(preview)
  })

  it('opts the runtime clone in and offers the preview beside the repo', async () => {
    const repo = makeRepo({ id: 'runtime-repo' })
    const preview = makePreview({
      hostId: 'runtime:env-1',
      repoId: repo.id,
      path: '/srv/runtime-repo'
    })
    addScriptMocks.resolveRequest.mockResolvedValue({ hostId: 'runtime:env-1' })
    mocks.callRuntimeRpc.mockResolvedValue({ repo, repositoryAddScriptPreview: preview })
    mocks.fetchWorktrees.mockResolvedValue(true)
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      activeRuntimeEnvironmentId: 'env-1',
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
        destination: '/srv',
        repositoryAddScriptPreview: { hostId: 'runtime:env-1' }
      },
      { timeoutMs: 10 * 60_000 }
    )
    expect(addScriptMocks.offer).toHaveBeenCalledWith(preview)
  })

  it('never clones onto this computer while the chosen host is unresolved', async () => {
    const { useAddRepoCloneFlow } = await import('./useAddRepoCloneFlow')

    const result = useAddRepoCloneFlow({
      step: 'clone',
      hostId: null,
      activeRuntimeEnvironmentId: null,
      workspaceDir: '/local/workspace',
      fetchWorktrees: mocks.fetchWorktrees,
      onGitRepoReady: mocks.onGitRepoReady
    })
    await result.handleClone()

    expect(mocks.cloneLocal).not.toHaveBeenCalled()
  })
})
