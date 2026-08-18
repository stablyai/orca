import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearBranchLineTotalRequestGateForTests,
  setBranchLineTotalMergeBase
} from './branch-line-total-request-gate'
import {
  clearGitStatusRefreshOrderingForTests,
  refreshGitStatusForWorktree,
  refreshGitStatusForWorktreeStrict,
  type GitStatusRefreshDeps
} from './git-status-refresh'
import type { GitStatusResult } from '../../../../shared/git-status-types'

const MERGE_BASE = '1f3c0d9a5b6e7f8091a2b3c4d5e6f708192a3b4c'

function makeDeps(): GitStatusRefreshDeps {
  return {
    setGitStatus: vi.fn(),
    updateWorktreeGitIdentity: vi.fn(),
    setUpstreamStatus: vi.fn(),
    fetchUpstreamStatus: vi.fn().mockResolvedValue(null)
  }
}

function stubGitStatus(): ReturnType<typeof vi.fn> {
  const status: GitStatusResult = {
    entries: [],
    conflictOperation: 'unknown',
    upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
  }
  const gitStatus = vi.fn().mockResolvedValue(status)
  vi.stubGlobal('window', {
    api: {
      git: {
        status: gitStatus,
        cancelStatus: vi.fn().mockResolvedValue(undefined),
        upstreamStatus: vi.fn().mockResolvedValue({ hasUpstream: false, ahead: 0, behind: 0 })
      }
    }
  })
  return gitStatus
}

describe('branch line total request gate on git status refreshes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearGitStatusRefreshOrderingForTests()
    clearBranchLineTotalRequestGateForTests()
  })

  it('omits the merge base when no chip is asking for a total', async () => {
    const gitStatus = stubGitStatus()

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-hidden',
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      deps: makeDeps()
    })

    // Why: no OID on the request is the whole performance contract — the host
    // runs no ranged diff, so a background worktree costs nothing.
    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: 'ssh-1'
    })
  })

  it('omits the merge base for a worktree whose chip was hidden again', async () => {
    const gitStatus = stubGitStatus()
    setBranchLineTotalMergeBase('wt-1', MERGE_BASE)
    setBranchLineTotalMergeBase('wt-1', null)

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      deps: makeDeps()
    })

    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined
    })
  })

  it('does not send one worktree gate on another worktree status pass', async () => {
    const gitStatus = stubGitStatus()
    setBranchLineTotalMergeBase('wt-visible', MERGE_BASE)

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-background',
      worktreePath: '/other-repo',
      deps: makeDeps()
    })

    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/other-repo',
      connectionId: undefined
    })
  })

  it('sends the merge base on a plain refresh that passes no request options', async () => {
    const gitStatus = stubGitStatus()
    setBranchLineTotalMergeBase('wt-1', MERGE_BASE)

    // Why: this path used to build no options object at all, so the gate was
    // silently dropped on the most common (fs-watcher) refresh.
    await refreshGitStatusForWorktree({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      deps: makeDeps()
    })

    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: 'ssh-1',
      branchLineTotalMergeBase: MERGE_BASE
    })
  })

  it('sends the merge base alongside line-stat reuse', async () => {
    const gitStatus = stubGitStatus()
    setBranchLineTotalMergeBase('wt-1', MERGE_BASE)

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      deps: makeDeps(),
      request: { reuseLineStats: true }
    })

    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      reuseLineStats: true,
      branchLineTotalMergeBase: MERGE_BASE
    })
  })

  it('sends the merge base on an abortable refresh', async () => {
    const gitStatus = stubGitStatus()
    setBranchLineTotalMergeBase('wt-1', MERGE_BASE)
    const controller = new AbortController()

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      deps: makeDeps(),
      request: { signal: controller.signal }
    })

    expect(gitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: '/repo',
        branchLineTotalMergeBase: MERGE_BASE
      })
    )
  })

  it('re-reads the gate on every pass so a moved fork point is not sent twice', async () => {
    const gitStatus = stubGitStatus()
    setBranchLineTotalMergeBase('wt-1', MERGE_BASE)

    await refreshGitStatusForWorktree({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      deps: makeDeps()
    })
    setBranchLineTotalMergeBase('wt-1', 'rebased-merge-base')
    await refreshGitStatusForWorktree({
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      deps: makeDeps()
    })

    expect(gitStatus).toHaveBeenNthCalledWith(1, {
      worktreePath: '/repo',
      connectionId: undefined,
      branchLineTotalMergeBase: MERGE_BASE
    })
    expect(gitStatus).toHaveBeenNthCalledWith(2, {
      worktreePath: '/repo',
      connectionId: undefined,
      branchLineTotalMergeBase: 'rebased-merge-base'
    })
  })

  it('omits the merge base from a strict refresh when no chip is visible', async () => {
    const gitStatus = stubGitStatus()

    await refreshGitStatusForWorktreeStrict({
      worktreeId: 'wt-strict',
      worktreePath: '/repo',
      deps: { ...makeDeps(), fetchUpstreamStatus: undefined }
    })

    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      bypassEffectiveUpstreamNegativeCache: true
    })
  })

  // Why: a strict refresh is exactly the commit/push/sync that moves the number;
  // skipping the gate there would blank the chip until the next automatic poll.
  it('sends the merge base on a strict refresh', async () => {
    const gitStatus = stubGitStatus()
    setBranchLineTotalMergeBase('wt-strict', MERGE_BASE)

    await refreshGitStatusForWorktreeStrict({
      worktreeId: 'wt-strict',
      worktreePath: '/repo',
      deps: { ...makeDeps(), fetchUpstreamStatus: undefined }
    })

    expect(gitStatus).toHaveBeenCalledWith({
      worktreePath: '/repo',
      connectionId: undefined,
      bypassEffectiveUpstreamNegativeCache: true,
      branchLineTotalMergeBase: MERGE_BASE
    })
  })
})
