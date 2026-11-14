import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearGitStatusRefreshOrderingForTests,
  refreshGitStatusForWorktree,
  refreshGitStatusForWorktreeStrict,
  type GitStatusRefreshDeps
} from './git-status-refresh'
import type {
  GitStatusResult,
  GitUpstreamStatus
} from '../../../../../../shared/git/status/git-status-types'

function makeDeps(): GitStatusRefreshDeps {
  return {
    setGitStatus: vi.fn(),
    updateWorktreeGitIdentity: vi.fn(),
    setUpstreamStatus: vi.fn(),
    fetchUpstreamStatus: vi.fn().mockResolvedValue(null)
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

describe('refreshGitStatusForWorktree', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearGitStatusRefreshOrderingForTests()
  })

  it('does not let an older automatic upstream result overwrite a strict result', async () => {
    const automaticStatus = deferred<GitStatusResult>()
    const strictStatus: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 0,
        behind: 1
      }
    }
    const staleAutomaticStatus: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
    }
    const gitStatus = vi
      .fn()
      .mockReturnValueOnce(automaticStatus.promise)
      .mockResolvedValueOnce(strictStatus)
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()

    const automatic = refreshGitStatusForWorktree({
      target: { kind: 'local' },
      ownerHostId: null,
      worktreeId: 'wt-race',
      worktreePath: '/repo',
      deps
    })
    await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1))

    await refreshGitStatusForWorktreeStrict({
      target: { kind: 'local' },
      ownerHostId: null,
      worktreeId: 'wt-race',
      worktreePath: '/repo',
      deps
    })
    automaticStatus.resolve(staleAutomaticStatus)
    await automatic

    expect(deps.setGitStatus).toHaveBeenCalledTimes(1)
    expect(deps.setGitStatus).toHaveBeenCalledWith('wt-race', strictStatus)
    expect(deps.updateWorktreeGitIdentity).toHaveBeenCalledTimes(1)
    expect(deps.setUpstreamStatus).toHaveBeenCalledTimes(1)
    expect(deps.setUpstreamStatus).toHaveBeenCalledWith('wt-race', strictStatus.upstreamStatus)
  })

  it('does not let an older automatic status overwrite the latest automatic result', async () => {
    const olderStatus = deferred<GitStatusResult>()
    const latestStatus: GitStatusResult = {
      entries: [{ path: 'latest.ts', status: 'modified', area: 'unstaged' }],
      conflictOperation: 'unknown',
      head: 'latest'
    }
    const gitStatus = vi
      .fn()
      .mockReturnValueOnce(olderStatus.promise)
      .mockResolvedValueOnce(latestStatus)
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()

    const olderRefresh = refreshGitStatusForWorktree({
      target: { kind: 'local' },
      ownerHostId: null,
      worktreeId: 'wt-automatic-race',
      worktreePath: '/repo',
      deps
    })
    await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1))
    await refreshGitStatusForWorktree({
      target: { kind: 'local' },
      ownerHostId: null,
      worktreeId: 'wt-automatic-race',
      worktreePath: '/repo',
      deps
    })
    olderStatus.resolve({
      entries: [{ path: 'older.ts', status: 'modified', area: 'unstaged' }],
      conflictOperation: 'unknown',
      head: 'older'
    })
    await olderRefresh

    expect(deps.setGitStatus).toHaveBeenCalledTimes(1)
    expect(deps.setGitStatus).toHaveBeenCalledWith('wt-automatic-race', latestStatus)
  })

  it('applies an earlier automatic result when a later automatic refresh fails', async () => {
    const olderStatus = deferred<GitStatusResult>()
    const gitStatus = vi
      .fn()
      .mockReturnValueOnce(olderStatus.promise)
      .mockRejectedValueOnce(new Error('transient index.lock'))
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()

    const olderRefresh = refreshGitStatusForWorktree({
      target: { kind: 'local' },
      ownerHostId: null,
      worktreeId: 'wt-failed-veto',
      worktreePath: '/repo',
      deps
    })
    await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1))
    await expect(
      refreshGitStatusForWorktree({
        target: { kind: 'local' },
        ownerHostId: null,
        worktreeId: 'wt-failed-veto',
        worktreePath: '/repo',
        deps
      })
    ).rejects.toThrow('transient index.lock')

    const freshStatus: GitStatusResult = {
      entries: [{ path: 'fresh.ts', status: 'modified', area: 'unstaged' }],
      conflictOperation: 'unknown',
      head: 'fresh'
    }
    olderStatus.resolve(freshStatus)
    await olderRefresh

    expect(deps.setGitStatus).toHaveBeenCalledWith('wt-failed-veto', freshStatus)
  })

  it('does not let an older automatic explicit upstream fetch overwrite a strict result', async () => {
    const automaticFetch = deferred<GitUpstreamStatus | null>()
    const strictStatus: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 0,
        behind: 1
      }
    }
    const staleAutomaticUpstream: GitUpstreamStatus = { hasUpstream: false, ahead: 0, behind: 0 }
    const gitStatus = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [],
        conflictOperation: 'unknown'
      } satisfies GitStatusResult)
      .mockResolvedValueOnce(strictStatus)
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()
    vi.mocked(deps.fetchUpstreamStatus).mockReturnValueOnce(automaticFetch.promise)

    const automatic = refreshGitStatusForWorktree({
      target: { kind: 'local' },
      ownerHostId: null,
      worktreeId: 'wt-fetch-race',
      worktreePath: '/repo',
      deps
    })
    await vi.waitFor(() => expect(deps.fetchUpstreamStatus).toHaveBeenCalledTimes(1))

    await refreshGitStatusForWorktreeStrict({
      target: { kind: 'local' },
      ownerHostId: null,
      worktreeId: 'wt-fetch-race',
      worktreePath: '/repo',
      deps
    })
    automaticFetch.resolve(staleAutomaticUpstream)
    await automatic

    expect(deps.setUpstreamStatus).toHaveBeenCalledTimes(1)
    expect(deps.setUpstreamStatus).toHaveBeenCalledWith(
      'wt-fetch-race',
      strictStatus.upstreamStatus
    )
  })
})
