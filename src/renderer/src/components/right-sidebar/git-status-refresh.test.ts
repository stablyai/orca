import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearGitStatusRefreshOrderingForTests,
  refreshGitStatusForWorktree,
  refreshGitStatusForWorktreeStrict,
  type GitStatusRefreshDeps
} from './git-status-refresh'
import type { GitStatusResult, GitUpstreamStatus } from '../../../../shared/types'

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

  it('stores status, branch identity, and upstream data from git status', async () => {
    const status: GitStatusResult = {
      entries: [{ path: 'src/index.ts', status: 'modified', area: 'unstaged' }],
      conflictOperation: 'unknown',
      head: 'abc123',
      branch: 'refs/heads/feature',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 2,
        behind: 1,
        behindCommitsArePatchEquivalent: false
      }
    }
    const gitStatus = vi.fn().mockResolvedValue(status)
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      deps
    })

    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: 'ssh-1'
    })
    expect(deps.setGitStatus).toHaveBeenCalledWith('wt-1', status)
    expect(deps.updateWorktreeGitIdentity).toHaveBeenCalledWith('wt-1', {
      head: 'abc123',
      branch: 'refs/heads/feature'
    })
    expect(deps.setUpstreamStatus).toHaveBeenCalledWith('wt-1', status.upstreamStatus)
    expect(deps.fetchUpstreamStatus).not.toHaveBeenCalled()
  })

  it('refreshes explicit upstream details without storing diverged porcelain-only status', async () => {
    const status: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 14,
        behind: 3
      }
    }
    const gitStatus = vi.fn().mockResolvedValue(status)
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      deps
    })

    expect(deps.setUpstreamStatus).not.toHaveBeenCalled()
    expect(deps.fetchUpstreamStatus).toHaveBeenCalledWith('wt-1', '/repo', undefined, undefined, {
      runtimeTargetSettings: undefined,
      applyUpstreamStatus: false
    })
  })

  it('falls back to explicit upstream refresh for legacy status payloads', async () => {
    const status: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      head: 'def456',
      branch: 'refs/heads/main'
    }
    const gitStatus = vi.fn().mockResolvedValue(status)
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-2',
      worktreePath: '/repo',
      connectionId: 'ssh-2',
      deps
    })

    expect(deps.setGitStatus).toHaveBeenCalledWith('wt-2', status)
    expect(deps.updateWorktreeGitIdentity).toHaveBeenCalledWith('wt-2', {
      head: 'def456',
      branch: 'refs/heads/main'
    })
    expect(deps.setUpstreamStatus).not.toHaveBeenCalled()
    expect(deps.fetchUpstreamStatus).toHaveBeenCalledWith('wt-2', '/repo', 'ssh-2', undefined, {
      runtimeTargetSettings: undefined,
      applyUpstreamStatus: false
    })
  })

  it('leaves ignored-file discovery to the File Explorer instead of status polling', async () => {
    const status: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown'
    }
    const gitStatus = vi.fn().mockResolvedValue(status)
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()

    await refreshGitStatusForWorktree({
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: 'wt-3',
      worktreePath: '/repo',
      deps
    })

    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(deps.setGitStatus).toHaveBeenCalledWith('wt-3', status)
  })

  it('bypasses automatic no-upstream backoff only for strict refreshes', async () => {
    const status: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
    }
    const gitStatus = vi.fn().mockResolvedValue(status)
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-normal',
      worktreePath: '/repo',
      deps
    })
    await refreshGitStatusForWorktreeStrict({
      worktreeId: 'wt-strict',
      worktreePath: '/repo',
      deps
    })

    expect(gitStatus).toHaveBeenNthCalledWith(1, {
      worktreePath: '/repo',
      connectionId: undefined
    })
    expect(gitStatus).toHaveBeenNthCalledWith(2, {
      worktreePath: '/repo',
      connectionId: undefined,
      bypassEffectiveUpstreamNegativeCache: true
    })
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
      worktreeId: 'wt-race',
      worktreePath: '/repo',
      deps
    })
    await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1))

    await refreshGitStatusForWorktreeStrict({
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
      worktreeId: 'wt-fetch-race',
      worktreePath: '/repo',
      deps
    })
    await vi.waitFor(() => expect(deps.fetchUpstreamStatus).toHaveBeenCalledTimes(1))

    await refreshGitStatusForWorktreeStrict({
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

  it('clears stale branch identity when git status reports detached HEAD', async () => {
    const status: GitStatusResult = {
      entries: [],
      conflictOperation: 'unknown',
      head: 'abc123456789'
    }
    const gitStatus = vi.fn().mockResolvedValue(status)
    vi.stubGlobal('window', { api: { git: { status: gitStatus } } })
    const deps = makeDeps()

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-detached',
      worktreePath: '/repo',
      deps
    })

    expect(deps.updateWorktreeGitIdentity).toHaveBeenCalledWith('wt-detached', {
      head: 'abc123456789',
      branch: null
    })
  })
})
