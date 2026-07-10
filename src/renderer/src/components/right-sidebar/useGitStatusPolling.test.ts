import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'
import type { FsChangedPayload, GitPushTarget, GitStatusResult } from '../../../../shared/types'

const worktree = { id: 'repo-1::/repo', repoId: 'repo-1', path: '/repo' }
const repo = { id: 'repo-1', path: '/repo', kind: 'git', connectionId: null as string | null }

type PollState = {
  activeWorktreeId: string
  updateWorktreeGitIdentity: ReturnType<typeof vi.fn>
  setGitStatus: ReturnType<typeof vi.fn>
  fetchUpstreamStatus: ReturnType<typeof vi.fn>
  setUpstreamStatus: ReturnType<typeof vi.fn>
  setConflictOperation: ReturnType<typeof vi.fn>
  gitConflictOperationByWorktree: Record<string, unknown>
  sshConnectionStates: Map<string, { status: string }>
  rightSidebarOpen?: boolean
  rightSidebarTab?: string
  rightSidebarExplorerView?: string
  openFiles?: unknown[]
  gitStatusHugeByWorktree?: Record<string, unknown>
}

type GitStatusPollingHook = (options?: { enabled?: boolean }) => void

function GitStatusPollingHarness({
  enabled,
  runPolling
}: {
  enabled?: boolean
  runPolling: GitStatusPollingHook
}): null {
  if (enabled === undefined) {
    runPolling()
  } else {
    runPolling({ enabled })
  }
  return null
}

async function usePollingOnce(
  status: GitStatusResult,
  options: {
    connectionId?: string | null
    pushTarget?: GitPushTarget
    sshStatus?: string
    enabled?: boolean
    expectStatusCall?: boolean
    stateOverrides?: Partial<PollState>
  } = {}
): Promise<{ state: PollState; gitStatus: ReturnType<typeof vi.fn> }> {
  vi.resetModules()

  const state: PollState = {
    activeWorktreeId: worktree.id,
    updateWorktreeGitIdentity: vi.fn(),
    setGitStatus: vi.fn(),
    fetchUpstreamStatus: vi.fn().mockResolvedValue(undefined),
    setUpstreamStatus: vi.fn(),
    setConflictOperation: vi.fn(),
    gitConflictOperationByWorktree: {},
    sshConnectionStates: new Map(
      options.connectionId && options.sshStatus
        ? [[options.connectionId, { status: options.sshStatus }]]
        : []
    ),
    rightSidebarOpen: true,
    rightSidebarTab: 'source-control',
    openFiles: []
  }
  Object.assign(state, options.stateOverrides)
  const mockedRepo = { ...repo, connectionId: options.connectionId ?? null }
  const gitStatus = vi.fn().mockResolvedValue(status)

  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof React>('react')
    return {
      ...actual,
      useCallback: (callback: unknown) => callback,
      useEffect: (effect: () => void | (() => void)) => {
        effect()
      },
      useMemo: (factory: () => unknown) => factory(),
      useRef: <T>(initial: T) => ({ current: initial })
    }
  })

  vi.doMock('@/store', () => ({
    useAppStore: Object.assign((selector: (s: PollState) => unknown) => selector(state), {
      getState: () => ({ settings: null })
    })
  }))

  vi.doMock('@/store/selectors', () => ({
    useActiveWorktree: () =>
      options.pushTarget ? { ...worktree, pushTarget: options.pushTarget } : worktree,
    useWorktreeById: () =>
      options.pushTarget ? { ...worktree, pushTarget: options.pushTarget } : worktree,
    useAllWorktrees: () => [worktree],
    useRepoById: () => mockedRepo,
    useRepoMap: () => new Map([[mockedRepo.id, mockedRepo]])
  }))

  vi.doMock('@/lib/connection-context', () => ({
    getConnectionId: () => options.connectionId ?? undefined
  }))

  vi.stubGlobal('window', {
    api: {
      git: {
        status: gitStatus
      },
      fs: {
        watchWorktree: vi.fn().mockResolvedValue(undefined),
        unwatchWorktree: vi.fn().mockResolvedValue(undefined),
        onFsChanged: vi.fn(() => vi.fn())
      },
      worktrees: {
        onChanged: vi.fn(() => vi.fn())
      }
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })

  vi.stubGlobal('document', {
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
  vi.stubGlobal('setInterval', vi.fn())
  vi.stubGlobal('clearInterval', vi.fn())

  const { useGitStatusPolling: runPolling } = await import('./useGitStatusPolling')
  GitStatusPollingHarness({ enabled: options.enabled, runPolling })
  await (options.expectStatusCall !== false
    ? vi.waitFor(() => {
        expect(state.setGitStatus).toHaveBeenCalled()
      })
    : Promise.resolve())

  return { state, gitStatus }
}

describe('useGitStatusPolling', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('uses upstream data from git status instead of spawning a separate upstream refresh', async () => {
    const { state } = await usePollingOnce({
      entries: [],
      conflictOperation: 'unknown',
      head: 'abc123',
      branch: 'refs/heads/main',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/main',
        ahead: 2,
        behind: 0
      }
    })

    expect(state.setUpstreamStatus).toHaveBeenCalledWith(worktree.id, {
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 0
    })
    expect(state.fetchUpstreamStatus).not.toHaveBeenCalled()
  })

  it('falls back to the upstream IPC for legacy status payloads', async () => {
    const { state } = await usePollingOnce({
      entries: [],
      conflictOperation: 'unknown',
      head: 'abc123',
      branch: 'refs/heads/main'
    })

    expect(state.setUpstreamStatus).not.toHaveBeenCalled()
    expect(state.fetchUpstreamStatus).toHaveBeenCalledWith(
      worktree.id,
      '/repo',
      undefined,
      undefined,
      {
        runtimeTargetSettings: { activeRuntimeEnvironmentId: null },
        applyUpstreamStatus: false
      }
    )
  })

  it('passes the explicit push target to upstream refreshes', async () => {
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }
    const { state } = await usePollingOnce(
      {
        entries: [],
        conflictOperation: 'unknown',
        head: 'abc123',
        branch: 'refs/heads/main'
      },
      { pushTarget }
    )

    expect(state.fetchUpstreamStatus).toHaveBeenCalledWith(
      worktree.id,
      '/repo',
      undefined,
      pushTarget,
      {
        runtimeTargetSettings: { activeRuntimeEnvironmentId: null },
        applyUpstreamStatus: false
      }
    )
  })

  it('skips remote git status polling while the SSH target is disconnected', async () => {
    const { state, gitStatus } = await usePollingOnce(
      {
        entries: [],
        conflictOperation: 'unknown',
        head: 'abc123',
        branch: 'refs/heads/main'
      },
      { connectionId: 'ssh-target-1', sshStatus: 'disconnected', expectStatusCall: false }
    )

    expect(gitStatus).not.toHaveBeenCalled()
    expect(state.setGitStatus).not.toHaveBeenCalled()
    expect(globalThis.setInterval).not.toHaveBeenCalled()
  })

  it('uses a slower git status cadence when only terminal branch detection needs polling', async () => {
    const { gitStatus } = await usePollingOnce(
      {
        entries: [],
        conflictOperation: 'unknown',
        head: 'abc123',
        branch: 'refs/heads/main'
      },
      {
        stateOverrides: {
          rightSidebarOpen: false,
          openFiles: []
        }
      }
    )

    expect(gitStatus).toHaveBeenCalledTimes(1)
    expect(globalThis.setInterval).toHaveBeenCalledWith(expect.any(Function), 30_000)
  })

  it('does not install the visible git status poll while disabled', async () => {
    const { state, gitStatus } = await usePollingOnce(
      {
        entries: [],
        conflictOperation: 'unknown',
        head: 'abc123',
        branch: 'refs/heads/main'
      },
      { enabled: false, expectStatusCall: false }
    )

    expect(gitStatus).not.toHaveBeenCalled()
    expect(state.setGitStatus).not.toHaveBeenCalled()
    expect(globalThis.setInterval).not.toHaveBeenCalled()
  })

  it('filters filesystem payloads to files inside the active worktree', async () => {
    vi.resetModules()
    const { shouldRefreshGitStatusForFileChange } = await import('./git-status-file-watch-refresh')

    expect(
      shouldRefreshGitStatusForFileChange(
        { worktreePath: '/repo', events: [{ kind: 'update', absolutePath: '/repo/src/app.ts' }] },
        '/repo'
      )
    ).toBe(true)
    expect(
      shouldRefreshGitStatusForFileChange(
        {
          worktreePath: '/repo',
          events: [{ kind: 'update', absolutePath: '/repo/src', isDirectory: true }]
        },
        '/repo'
      )
    ).toBe(false)
    expect(
      shouldRefreshGitStatusForFileChange(
        { worktreePath: '/other', events: [{ kind: 'overflow', absolutePath: '/other' }] },
        '/repo'
      )
    ).toBe(false)
    expect(
      shouldRefreshGitStatusForFileChange(
        { worktreePath: '/repo', events: [{ kind: 'overflow', absolutePath: '/repo' }] },
        '/repo'
      )
    ).toBe(true)
  })

  it('coalesces active worktree file-watch bursts into one git status refresh', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const windowListeners = new Map<string, EventListener[]>()
    const emitWorktreeFileChange = (payload: FsChangedPayload): void => {
      for (const listener of windowListeners.get('orca:worktree-file-change') ?? []) {
        listener({ detail: { payload, runtimeEnvironmentId: null } } as CustomEvent)
      }
    }
    const status: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      head: 'abc123',
      branch: 'refs/heads/main'
    }
    const state: PollState = {
      activeWorktreeId: worktree.id,
      updateWorktreeGitIdentity: vi.fn(),
      setGitStatus: vi.fn(),
      fetchUpstreamStatus: vi.fn().mockResolvedValue(undefined),
      setUpstreamStatus: vi.fn(),
      setConflictOperation: vi.fn(),
      gitConflictOperationByWorktree: {},
      sshConnectionStates: new Map(),
      rightSidebarOpen: true,
      rightSidebarTab: 'source-control',
      openFiles: []
    }
    const gitStatus = vi.fn().mockResolvedValue(status)

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof React>('react')
      return {
        ...actual,
        useCallback: (callback: unknown) => callback,
        useEffect: (effect: () => void | (() => void)) => {
          effect()
        },
        useMemo: (factory: () => unknown) => factory(),
        useRef: <T>(initial: T) => ({ current: initial })
      }
    })
    vi.doMock('@/store', () => ({
      useAppStore: Object.assign((selector: (s: PollState) => unknown) => selector(state), {
        getState: () => ({ settings: null })
      })
    }))
    vi.doMock('@/store/selectors', () => ({
      useActiveWorktree: () => worktree,
      useWorktreeById: () => worktree,
      useAllWorktrees: () => [worktree],
      useRepoById: () => repo,
      useRepoMap: () => new Map([[repo.id, repo]])
    }))
    vi.doMock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))
    vi.stubGlobal('window', {
      api: {
        git: { status: gitStatus },
        fs: {
          watchWorktree: vi.fn().mockResolvedValue(undefined),
          unwatchWorktree: vi.fn().mockResolvedValue(undefined),
          onFsChanged: vi.fn(() => vi.fn())
        },
        worktrees: {
          onChanged: vi.fn(() => vi.fn())
        }
      },
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener])
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.set(
          type,
          (windowListeners.get(type) ?? []).filter((candidate) => candidate !== listener)
        )
      })
    })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      hasFocus: () => true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })

    const { useGitStatusPolling: runPolling } = await import('./useGitStatusPolling')
    GitStatusPollingHarness({ runPolling })
    await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1))

    expect(windowListeners.get('orca:worktree-file-change')?.length).toBe(1)
    emitWorktreeFileChange({
      worktreePath: '/repo',
      events: [{ kind: 'update', absolutePath: '/repo/a.ts' }]
    })
    emitWorktreeFileChange({
      worktreePath: '/repo',
      events: [{ kind: 'create', absolutePath: '/repo/b.ts' }]
    })
    emitWorktreeFileChange({
      worktreePath: '/other',
      events: [{ kind: 'update', absolutePath: '/other/c.ts' }]
    })

    await vi.advanceTimersByTimeAsync(125)
    expect(gitStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2875)
    await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(2))
    expect(window.api.fs.watchWorktree).not.toHaveBeenCalled()
    expect(window.api.fs.unwatchWorktree).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('does not refresh git status from file-watch events while the window is hidden', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const windowListeners = new Map<string, EventListener[]>()
    const emitWorktreeFileChange = (payload: FsChangedPayload): void => {
      for (const listener of windowListeners.get('orca:worktree-file-change') ?? []) {
        listener({ detail: { payload, runtimeEnvironmentId: null } } as CustomEvent)
      }
    }
    const status: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      head: 'abc123',
      branch: 'refs/heads/main'
    }
    const state: PollState = {
      activeWorktreeId: worktree.id,
      updateWorktreeGitIdentity: vi.fn(),
      setGitStatus: vi.fn(),
      fetchUpstreamStatus: vi.fn().mockResolvedValue(undefined),
      setUpstreamStatus: vi.fn(),
      setConflictOperation: vi.fn(),
      gitConflictOperationByWorktree: {},
      sshConnectionStates: new Map(),
      rightSidebarOpen: true,
      rightSidebarTab: 'source-control',
      openFiles: []
    }
    const gitStatus = vi.fn().mockResolvedValue(status)

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof React>('react')
      return {
        ...actual,
        useCallback: (callback: unknown) => callback,
        useEffect: (effect: () => void | (() => void)) => {
          effect()
        },
        useMemo: (factory: () => unknown) => factory(),
        useRef: <T>(initial: T) => ({ current: initial })
      }
    })
    vi.doMock('@/store', () => ({
      useAppStore: Object.assign((selector: (s: PollState) => unknown) => selector(state), {
        getState: () => ({ settings: null })
      })
    }))
    vi.doMock('@/store/selectors', () => ({
      useActiveWorktree: () => worktree,
      useWorktreeById: () => worktree,
      useAllWorktrees: () => [worktree],
      useRepoById: () => repo,
      useRepoMap: () => new Map([[repo.id, repo]])
    }))
    vi.doMock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))
    vi.stubGlobal('window', {
      api: {
        git: { status: gitStatus },
        fs: {
          watchWorktree: vi.fn().mockResolvedValue(undefined),
          unwatchWorktree: vi.fn().mockResolvedValue(undefined),
          onFsChanged: vi.fn(() => vi.fn())
        },
        worktrees: {
          onChanged: vi.fn(() => vi.fn())
        }
      },
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener])
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.set(
          type,
          (windowListeners.get(type) ?? []).filter((candidate) => candidate !== listener)
        )
      })
    })
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      hasFocus: () => false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })

    const { useGitStatusPolling: runPolling } = await import('./useGitStatusPolling')
    GitStatusPollingHarness({ runPolling })

    expect(windowListeners.get('orca:worktree-file-change')?.length).toBe(1)
    emitWorktreeFileChange({
      worktreePath: '/repo',
      events: [{ kind: 'update', absolutePath: '/repo/a.ts' }]
    })
    await vi.advanceTimersByTimeAsync(200)

    expect(gitStatus).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('keeps a pending file-watch refresh across harmless open-file rerenders', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const windowListeners = new Map<string, EventListener[]>()
    const emitWorktreeFileChange = (payload: FsChangedPayload): void => {
      for (const listener of windowListeners.get('orca:worktree-file-change') ?? []) {
        listener({ detail: { payload, runtimeEnvironmentId: null } } as CustomEvent)
      }
    }
    const status: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      head: 'abc123',
      branch: 'refs/heads/main'
    }
    const state: PollState = {
      activeWorktreeId: worktree.id,
      updateWorktreeGitIdentity: vi.fn(),
      setGitStatus: vi.fn(),
      fetchUpstreamStatus: vi.fn().mockResolvedValue(undefined),
      setUpstreamStatus: vi.fn(),
      setConflictOperation: vi.fn(),
      gitConflictOperationByWorktree: {},
      sshConnectionStates: new Map(),
      rightSidebarOpen: true,
      rightSidebarTab: 'source-control',
      openFiles: []
    }
    const gitStatus = vi.fn().mockResolvedValue(status)
    const effectSlots: {
      deps: unknown[] | undefined
      cleanup: void | (() => void)
    }[] = []
    const refSlots: { current: unknown }[] = []
    let effectIndex = 0
    let refIndex = 0
    const depsChanged = (prev: unknown[] | undefined, next: unknown[] | undefined): boolean =>
      !prev ||
      !next ||
      prev.length !== next.length ||
      prev.some((value, index) => value !== next[index])

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof React>('react')
      return {
        ...actual,
        useCallback: (callback: unknown) => callback,
        useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
          const index = effectIndex
          effectIndex += 1
          const previous = effectSlots[index]
          if (!previous || depsChanged(previous.deps, deps)) {
            previous?.cleanup?.()
            effectSlots[index] = { deps, cleanup: effect() }
          }
        },
        useMemo: (factory: () => unknown) => factory(),
        useRef: <T>(initial: T) => {
          const index = refIndex
          refIndex += 1
          if (!refSlots[index]) {
            refSlots[index] = { current: initial }
          }
          return refSlots[index] as { current: T }
        }
      }
    })
    vi.doMock('@/store', () => ({
      useAppStore: Object.assign((selector: (s: PollState) => unknown) => selector(state), {
        getState: () => ({ settings: null })
      })
    }))
    vi.doMock('@/store/selectors', () => ({
      useActiveWorktree: () => worktree,
      useWorktreeById: () => worktree,
      useAllWorktrees: () => [worktree],
      useRepoById: () => repo,
      useRepoMap: () => new Map([[repo.id, repo]])
    }))
    vi.doMock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))
    vi.stubGlobal('window', {
      api: {
        git: { status: gitStatus },
        fs: {
          watchWorktree: vi.fn().mockResolvedValue(undefined),
          unwatchWorktree: vi.fn().mockResolvedValue(undefined),
          onFsChanged: vi.fn(() => vi.fn())
        },
        worktrees: {
          onChanged: vi.fn(() => vi.fn())
        }
      },
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener])
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.set(
          type,
          (windowListeners.get(type) ?? []).filter((candidate) => candidate !== listener)
        )
      })
    })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      hasFocus: () => true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })

    const { useGitStatusPolling: runPolling } = await import('./useGitStatusPolling')
    const renderPolling = (): void => {
      effectIndex = 0
      refIndex = 0
      GitStatusPollingHarness({ runPolling })
    }
    renderPolling()
    await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1))

    emitWorktreeFileChange({
      worktreePath: '/repo',
      events: [{ kind: 'update', absolutePath: '/repo/a.ts' }]
    })
    await vi.advanceTimersByTimeAsync(60)
    state.openFiles = [{}]
    renderPolling()
    expect(windowListeners.get('orca:worktree-file-change')?.length).toBe(1)
    expect(window.removeEventListener).not.toHaveBeenCalledWith(
      'orca:worktree-file-change',
      expect.any(Function)
    )
    const callsBeforeDebounceFires = gitStatus.mock.calls.length

    await vi.advanceTimersByTimeAsync(65)
    expect(gitStatus).toHaveBeenCalledTimes(callsBeforeDebounceFires)
    await vi.advanceTimersByTimeAsync(2875)
    await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(callsBeforeDebounceFires + 1))

    vi.useRealTimers()
  })

  it('does not overlap slow visible git status polls and runs one trailing refresh', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    let intervalCallback: (() => void) | null = null
    let resolveFirst!: (value: GitStatusResult) => void
    const firstStatus = new Promise<GitStatusResult>((resolve) => {
      resolveFirst = resolve
    })
    const state: PollState = {
      activeWorktreeId: worktree.id,
      updateWorktreeGitIdentity: vi.fn(),
      setGitStatus: vi.fn(),
      fetchUpstreamStatus: vi.fn().mockResolvedValue(undefined),
      setUpstreamStatus: vi.fn(),
      setConflictOperation: vi.fn(),
      gitConflictOperationByWorktree: {},
      sshConnectionStates: new Map(),
      rightSidebarOpen: true,
      rightSidebarTab: 'source-control',
      openFiles: []
    }
    const status: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      head: 'abc123',
      branch: 'refs/heads/main'
    }
    const gitStatus = vi.fn().mockReturnValueOnce(firstStatus).mockResolvedValue(status)

    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof React>('react')
      return {
        ...actual,
        useCallback: (callback: unknown) => callback,
        useEffect: (effect: () => void | (() => void)) => {
          effect()
        },
        useMemo: (factory: () => unknown) => factory(),
        useRef: <T>(initial: T) => ({ current: initial })
      }
    })

    vi.doMock('@/store', () => ({
      useAppStore: Object.assign((selector: (s: PollState) => unknown) => selector(state), {
        getState: () => ({ settings: null })
      })
    }))
    vi.doMock('@/store/selectors', () => ({
      useActiveWorktree: () => worktree,
      useWorktreeById: () => worktree,
      useAllWorktrees: () => [worktree],
      useRepoById: () => repo,
      useRepoMap: () => new Map([[repo.id, repo]])
    }))
    vi.doMock('@/lib/connection-context', () => ({
      getConnectionId: () => undefined
    }))

    vi.stubGlobal('window', {
      api: {
        git: { status: gitStatus },
        fs: {
          watchWorktree: vi.fn().mockResolvedValue(undefined),
          unwatchWorktree: vi.fn().mockResolvedValue(undefined),
          onFsChanged: vi.fn(() => vi.fn())
        },
        worktrees: {
          onChanged: vi.fn(() => vi.fn())
        }
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      hasFocus: () => false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal(
      'setInterval',
      vi.fn((callback: () => void) => {
        intervalCallback = callback
        return 1
      })
    )
    vi.stubGlobal('clearInterval', vi.fn())

    const { useGitStatusPolling: runPolling } = await import('./useGitStatusPolling')
    GitStatusPollingHarness({ runPolling })
    await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1))

    expect(intervalCallback).toBeTypeOf('function')
    const tick = intervalCallback as unknown as () => void
    tick()
    tick()
    expect(gitStatus).toHaveBeenCalledTimes(1)

    resolveFirst(status)
    await vi.waitFor(() => expect(state.setGitStatus).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(3000)
    await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(state.setGitStatus).toHaveBeenCalledTimes(2))
    vi.useRealTimers()
  })
})
