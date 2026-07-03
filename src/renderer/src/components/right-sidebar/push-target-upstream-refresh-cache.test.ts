import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearGitStatusRefreshOrderingForTests,
  refreshGitStatusForWorktree,
  refreshGitStatusForWorktreeStrict,
  type GitStatusRefreshDeps
} from './git-status-refresh'
import {
  getCachedAutomaticPushTargetUpstreamStatus,
  invalidateAutomaticPushTargetUpstreamStatusCache,
  storeCachedAutomaticPushTargetUpstreamStatus
} from './push-target-upstream-refresh-cache'
import type { GitPushTarget, GitStatusResult, GitUpstreamStatus } from '../../../../shared/types'

const pushTarget: GitPushTarget = {
  remoteName: 'fork',
  branchName: 'feature/pr-head',
  remoteUrl: 'https://github.com/contributor/orca.git'
}

const unchangedStatus: GitStatusResult = {
  entries: [],
  conflictOperation: 'unknown',
  head: 'abc123',
  branch: 'refs/heads/feature'
}

function makeDeps(): GitStatusRefreshDeps {
  return {
    setGitStatus: vi.fn(),
    updateWorktreeGitIdentity: vi.fn(),
    setUpstreamStatus: vi.fn(),
    fetchUpstreamStatus: vi.fn().mockResolvedValue({
      hasUpstream: true,
      upstreamName: 'fork/feature/pr-head',
      ahead: 1,
      behind: 0
    } satisfies GitUpstreamStatus)
  }
}

function stubGitStatus(statuses: GitStatusResult[]): ReturnType<typeof vi.fn> {
  const gitStatus = vi.fn()
  for (const status of statuses) {
    gitStatus.mockResolvedValueOnce(status)
  }
  gitStatus.mockResolvedValue(statuses.at(-1) ?? unchangedStatus)
  vi.stubGlobal('window', {
    api: {
      git: {
        status: gitStatus,
        upstreamStatus: vi.fn().mockResolvedValue({
          hasUpstream: true,
          upstreamName: 'fork/feature/pr-head',
          ahead: 9,
          behind: 0
        } satisfies GitUpstreamStatus)
      }
    }
  })
  return gitStatus
}

async function refreshAutomatically(options: {
  deps: GitStatusRefreshDeps
  connectionId?: string
  runtimeEnvironmentId?: string | null
  pushTarget?: GitPushTarget
}): Promise<void> {
  await refreshGitStatusForWorktree({
    settings: { activeRuntimeEnvironmentId: options.runtimeEnvironmentId ?? null },
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    connectionId: options.connectionId,
    pushTarget: options.pushTarget ?? pushTarget,
    deps: options.deps
  })
}

describe('push-target upstream refresh cache', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useFakeTimers()
    vi.setSystemTime(0)
    clearGitStatusRefreshOrderingForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses the publish-target upstream comparison across unchanged automatic polls', async () => {
    stubGitStatus([unchangedStatus])
    const deps = makeDeps()

    await refreshAutomatically({ deps })
    await refreshAutomatically({ deps })
    await refreshAutomatically({ deps })

    expect(deps.fetchUpstreamStatus).toHaveBeenCalledTimes(1)
    expect(deps.setUpstreamStatus).toHaveBeenCalledTimes(1)
    expect(deps.setUpstreamStatus).toHaveBeenLastCalledWith('wt-1', {
      hasUpstream: true,
      upstreamName: 'fork/feature/pr-head',
      ahead: 1,
      behind: 0
    })
  })

  it('retries after a failed push-target refresh invalidates an unchanged automatic poll cache hit', async () => {
    stubGitStatus([unchangedStatus])
    const deps = makeDeps()
    vi.mocked(deps.fetchUpstreamStatus)
      .mockResolvedValueOnce({
        hasUpstream: true,
        upstreamName: 'fork/feature/pr-head',
        ahead: 1,
        behind: 0
      })
      .mockResolvedValueOnce({
        hasUpstream: true,
        upstreamName: 'fork/feature/pr-head',
        ahead: 0,
        behind: 0
      })

    await refreshAutomatically({ deps })
    invalidateAutomaticPushTargetUpstreamStatusCache({
      settings: { activeRuntimeEnvironmentId: null },
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      pushTarget
    })
    await refreshAutomatically({ deps })
    await refreshAutomatically({ deps })

    expect(deps.fetchUpstreamStatus).toHaveBeenCalledTimes(2)
    expect(deps.setUpstreamStatus).toHaveBeenLastCalledWith('wt-1', {
      hasUpstream: true,
      upstreamName: 'fork/feature/pr-head',
      ahead: 0,
      behind: 0
    })
  })

  it('refreshes again when HEAD changes', async () => {
    stubGitStatus([
      { ...unchangedStatus, head: 'abc123' },
      { ...unchangedStatus, head: 'def456' }
    ])
    const deps = makeDeps()

    await refreshAutomatically({ deps })
    await refreshAutomatically({ deps })

    expect(deps.fetchUpstreamStatus).toHaveBeenCalledTimes(2)
  })

  it('refreshes again when the push target changes', async () => {
    stubGitStatus([unchangedStatus])
    const deps = makeDeps()

    await refreshAutomatically({ deps })
    await refreshAutomatically({
      deps,
      pushTarget: { ...pushTarget, branchName: 'feature/retargeted-pr-head' }
    })

    expect(deps.fetchUpstreamStatus).toHaveBeenCalledTimes(2)
  })

  it('refreshes again after the automatic cache window expires', async () => {
    stubGitStatus([unchangedStatus])
    const deps = makeDeps()

    await refreshAutomatically({ deps })
    vi.setSystemTime(59_999)
    await refreshAutomatically({ deps })
    vi.setSystemTime(60_000)
    await refreshAutomatically({ deps })

    expect(deps.fetchUpstreamStatus).toHaveBeenCalledTimes(2)
  })

  it('separates automatic cache entries by SSH connection', async () => {
    stubGitStatus([unchangedStatus])
    const deps = makeDeps()

    await refreshAutomatically({ deps, connectionId: 'ssh-1' })
    await refreshAutomatically({ deps, connectionId: 'ssh-2' })

    expect(deps.fetchUpstreamStatus).toHaveBeenCalledTimes(2)
  })

  it('separates automatic cache entries by runtime target', () => {
    const upstreamStatus: GitUpstreamStatus = {
      hasUpstream: true,
      upstreamName: 'fork/feature/pr-head',
      ahead: 1,
      behind: 0
    }

    storeCachedAutomaticPushTargetUpstreamStatus(
      {
        settings: { activeRuntimeEnvironmentId: 'runtime-1' },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        pushTarget,
        status: unchangedStatus
      },
      upstreamStatus
    )

    expect(
      getCachedAutomaticPushTargetUpstreamStatus({
        settings: { activeRuntimeEnvironmentId: 'runtime-2' },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        pushTarget,
        status: unchangedStatus
      })
    ).toBeNull()
  })

  it('does not reuse automatic push-target cache for strict refreshes', async () => {
    stubGitStatus([unchangedStatus])
    const deps = makeDeps()

    await refreshAutomatically({ deps })
    await refreshGitStatusForWorktreeStrict({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      pushTarget,
      deps
    })

    expect(deps.fetchUpstreamStatus).toHaveBeenCalledTimes(1)
    expect(window.api.git.upstreamStatus).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      pushTarget
    })
    expect(deps.setUpstreamStatus).toHaveBeenLastCalledWith('wt-1', {
      hasUpstream: true,
      upstreamName: 'fork/feature/pr-head',
      ahead: 9,
      behind: 0
    })
  })
})
