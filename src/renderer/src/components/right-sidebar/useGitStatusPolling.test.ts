import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'
import type { GitStatusResult } from '../../../../shared/types'

const worktree = { id: 'repo-1::/repo', repoId: 'repo-1', path: '/repo' }
const repo = { id: 'repo-1', path: '/repo', kind: 'git' }

type PollState = {
  activeWorktreeId: string
  updateWorktreeGitIdentity: ReturnType<typeof vi.fn>
  setGitStatus: ReturnType<typeof vi.fn>
  fetchUpstreamStatus: ReturnType<typeof vi.fn>
  setUpstreamStatus: ReturnType<typeof vi.fn>
  setConflictOperation: ReturnType<typeof vi.fn>
  gitConflictOperationByWorktree: Record<string, unknown>
}

type GitStatusPollingHook = () => void

function GitStatusPollingHarness({ runPolling }: { runPolling: GitStatusPollingHook }): null {
  runPolling()
  return null
}

async function usePollingOnce(status: GitStatusResult): Promise<PollState> {
  vi.resetModules()

  const state: PollState = {
    activeWorktreeId: worktree.id,
    updateWorktreeGitIdentity: vi.fn(),
    setGitStatus: vi.fn(),
    fetchUpstreamStatus: vi.fn().mockResolvedValue(undefined),
    setUpstreamStatus: vi.fn(),
    setConflictOperation: vi.fn(),
    gitConflictOperationByWorktree: {}
  }

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
    useRepoById: () => repo,
    useRepoMap: () => new Map([[repo.id, repo]])
  }))

  vi.doMock('@/lib/connection-context', () => ({
    getConnectionId: () => undefined
  }))

  vi.stubGlobal('window', {
    api: {
      git: {
        status: vi.fn().mockResolvedValue(status)
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
  await vi.waitFor(() => {
    expect(state.setGitStatus).toHaveBeenCalled()
  })

  return state
}

describe('useGitStatusPolling', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses upstream data from git status instead of spawning a separate upstream refresh', async () => {
    const state = await usePollingOnce({
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
    const state = await usePollingOnce({
      entries: [],
      conflictOperation: 'unknown',
      head: 'abc123',
      branch: 'refs/heads/main'
    })

    expect(state.setUpstreamStatus).not.toHaveBeenCalled()
    expect(state.fetchUpstreamStatus).toHaveBeenCalledWith(worktree.id, '/repo', undefined)
  })
})
