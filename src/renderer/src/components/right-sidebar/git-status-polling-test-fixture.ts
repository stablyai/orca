import { expect, vi } from 'vitest'
import type * as React from 'react'
import type { GitStatusResult } from '../../../../shared/git-status-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'

export const worktree = { id: 'repo-1::/repo', repoId: 'repo-1', path: '/repo' }
export const repo = {
  id: 'repo-1',
  path: '/repo',
  kind: 'git',
  connectionId: null as string | null
}

export type PollState = {
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

export function GitStatusPollingHarness({
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

export async function usePollingOnce(
  status: GitStatusResult,
  options: {
    connectionId?: string | null
    pushTarget?: GitPushTarget
    sshStatus?: string
    enabled?: boolean
    expectStatusCall?: boolean
    stateOverrides?: Partial<PollState>
    documentStub?: object
    repo?: Repo
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
  const mockedRepo = options.repo ?? { ...repo, connectionId: options.connectionId ?? null }
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

  vi.stubGlobal(
    'document',
    options.documentStub ?? {
      visibilityState: 'visible',
      hasFocus: () => true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  )
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
