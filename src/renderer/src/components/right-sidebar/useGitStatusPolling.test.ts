import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'
import type { GitStatusResult } from '../../../../shared/types'

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
}

type GitStatusPollingHook = () => void

function GitStatusPollingHarness({ runPolling }: { runPolling: GitStatusPollingHook }): null {
  runPolling()
  return null
}

async function usePollingOnce(
  status: GitStatusResult,
  options: {
    connectionId?: string | null
    sshStatus?: string
    expectStatusCall?: boolean
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
    )
  }
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
      useMemo: (factory: () => unknown) => factory()
    }
  })

  vi.doMock('@/store', () => ({
    useAppStore: Object.assign((selector: (s: PollState) => unknown) => selector(state), {
      getState: () => ({ settings: null })
    })
  }))

  vi.doMock('@/store/selectors', () => ({
    useActiveWorktree: () => worktree,
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
      }
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })

  vi.stubGlobal('document', { hasFocus: () => true })
  vi.stubGlobal('setInterval', vi.fn())
  vi.stubGlobal('clearInterval', vi.fn())

  const { useGitStatusPolling: runPolling } = await import('./useGitStatusPolling')
  GitStatusPollingHarness({ runPolling })
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
        behind: 1
      }
    })

    expect(state.setUpstreamStatus).toHaveBeenCalledWith(worktree.id, {
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 1
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
    expect(state.fetchUpstreamStatus).toHaveBeenCalledWith(worktree.id, '/repo', undefined)
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
  })
})
