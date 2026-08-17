// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRuntimeGitBranchCompare: vi.fn(),
  beginGitBranchCompareRequest: vi.fn(),
  setGitBranchCompareResult: vi.fn(),
  clearGitBranchCompare: vi.fn(),
  gitBranchCompareSummaryByWorktree: {} as Record<string, { baseRef: string } | undefined>
}))

vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitBranchCompare: mocks.getRuntimeGitBranchCompare
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))
vi.mock('@/store', () => {
  const state = {
    beginGitBranchCompareRequest: mocks.beginGitBranchCompareRequest,
    setGitBranchCompareResult: mocks.setGitBranchCompareResult,
    clearGitBranchCompare: mocks.clearGitBranchCompare,
    get gitBranchCompareSummaryByWorktree() {
      return mocks.gitBranchCompareSummaryByWorktree
    }
  }
  const useAppStore = <T,>(selector: (s: typeof state) => T): T => selector(state)
  useAppStore.getState = (): typeof state => state
  return { useAppStore }
})

import {
  BRANCH_REFRESH_INTERVAL_MS,
  useSourceControlBranchCompare
} from './source-control/sync/use-branch-compare'
import { deferred, flush, mountProbe, unmountProbes } from './source-control-hook-test-harness'
import type { GitBranchCompareResult } from '../../../../shared/git-diff-compare-types'
import type { GitUpstreamStatus } from '../../../../shared/git-status-types'

type Api = ReturnType<typeof useSourceControlBranchCompare>

let latest: Api | null = null

function Probe(props: {
  worktreeId?: string | null
  compareBaseRef?: string | null
  isFolder?: boolean
  isBranchVisible?: boolean
  statusHead?: string | null
  remoteStatus?: GitUpstreamStatus | undefined
}): null {
  latest = useSourceControlBranchCompare({
    activeRepoSettings: null,
    activeWorktreeId: props.worktreeId === undefined ? 'A' : props.worktreeId,
    worktreePath: '/a',
    compareBaseRef: props.compareBaseRef === undefined ? 'origin/main' : props.compareBaseRef,
    isFolder: props.isFolder ?? false,
    branchName: 'feature',
    // Why: default off so only explicit refreshes run — effect-driven refreshes are exercised in their own cases.
    isBranchVisible: props.isBranchVisible ?? false,
    activeGitStatusHead: props.statusHead ?? null,
    remoteStatus: props.remoteStatus
  })
  return null
}

/** Mounts the probe; omitted props fall back to the defaults declared in `Probe`. */
async function mount(props: Parameters<typeof Probe>[0] = {}): Promise<Root> {
  return mountProbe(<Probe {...props} />)
}

const OK: GitBranchCompareResult = {
  summary: {
    baseRef: 'origin/main',
    baseOid: null,
    compareRef: 'feature',
    headOid: null,
    mergeBase: null,
    changedFiles: 0,
    status: 'ready'
  },
  entries: []
}

beforeEach(() => {
  mocks.getRuntimeGitBranchCompare.mockResolvedValue(OK)
})

afterEach(() => {
  unmountProbes()
  vi.useRealTimers()
  // Why: resetAllMocks also drops unconsumed mockReturnValueOnce queues; beforeEach restores the default.
  vi.resetAllMocks()
  mocks.gitBranchCompareSummaryByWorktree = {}
  latest = null
})

describe('useSourceControlBranchCompare scheduler', () => {
  it('collapses every call made during an in-flight run into a single trailing refresh', async () => {
    const first = deferred<typeof OK>()
    mocks.getRuntimeGitBranchCompare.mockReturnValueOnce(first.promise)
    await mount()

    void latest?.refreshBranchCompare()
    await flush()
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(1)

    // Five skipped ticks must not stack five git subprocesses.
    for (let i = 0; i < 5; i += 1) {
      void latest?.refreshBranchCompare()
    }
    await flush()
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve(OK)
    })
    await flush()
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(2)
  })

  it('does not lose the trailing refresh when the call arrives late in the run', async () => {
    const first = deferred<typeof OK>()
    mocks.getRuntimeGitBranchCompare.mockReturnValueOnce(first.promise)
    await mount()

    void latest?.refreshBranchCompare()
    await flush()
    void latest?.refreshBranchCompare()

    await act(async () => {
      first.resolve(OK)
    })
    await flush()
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(2)
  })

  it('chains another trailing run when a call lands during the trailing run', async () => {
    const first = deferred<typeof OK>()
    const second = deferred<typeof OK>()
    mocks.getRuntimeGitBranchCompare
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    await mount()

    void latest?.refreshBranchCompare()
    await flush()
    void latest?.refreshBranchCompare()
    await act(async () => {
      first.resolve(OK)
    })
    await flush()
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(2)

    // A call during the trailing run schedules one more, not zero.
    void latest?.refreshBranchCompare()
    await act(async () => {
      second.resolve(OK)
    })
    await flush()
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(3)
  })

  it('keeps a coalesced caller awaiting the shared run promise until the trailing run finishes', async () => {
    const first = deferred<typeof OK>()
    const second = deferred<typeof OK>()
    mocks.getRuntimeGitBranchCompare
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    await mount()

    let leadSettled = false
    let coalescedSettled = false
    void latest?.refreshBranchCompare().then(() => {
      leadSettled = true
    })
    await flush()
    void latest?.refreshBranchCompare().then(() => {
      coalescedSettled = true
    })
    await flush()
    expect(leadSettled).toBe(false)
    expect(coalescedSettled).toBe(false)

    await act(async () => {
      first.resolve(OK)
    })
    await flush()
    // Trailing run is still open, so neither caller may report completion yet.
    expect(leadSettled).toBe(false)
    expect(coalescedSettled).toBe(false)

    await act(async () => {
      second.resolve(OK)
    })
    await flush()
    expect(leadSettled).toBe(true)
    expect(coalescedSettled).toBe(true)
  })

  it('releases the single-flight lock after a failed run so later refreshes still fire', async () => {
    mocks.getRuntimeGitBranchCompare.mockRejectedValueOnce(new Error('git exploded'))
    await mount()

    await act(async () => {
      await latest?.refreshBranchCompare()
    })
    expect(mocks.setGitBranchCompareResult).toHaveBeenCalledWith(
      'A',
      expect.any(String),
      expect.objectContaining({
        summary: expect.objectContaining({ status: 'error', errorMessage: 'git exploded' })
      })
    )

    await act(async () => {
      await latest?.refreshBranchCompare()
    })
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(2)
  })

  it('runs sequential refreshes immediately once the chain has drained', async () => {
    await mount()
    await act(async () => {
      await latest?.refreshBranchCompare()
    })
    await act(async () => {
      await latest?.refreshBranchCompare()
    })
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(2)
  })

  it('collapses a poll tick that fires while a refresh is in flight', async () => {
    vi.useFakeTimers()
    const first = deferred<typeof OK>()
    mocks.getRuntimeGitBranchCompare.mockReturnValueOnce(first.promise)
    // Visible mounts run once immediately through the visibility interval.
    await mount({ isBranchVisible: true })
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(BRANCH_REFRESH_INTERVAL_MS * 3)
    })
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve(OK)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    // Three skipped ticks collapse into exactly one trailing run.
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(2)
  })

  it('preserves the existing summary on a poll refresh but resets to loading on a base-ref change', async () => {
    mocks.gitBranchCompareSummaryByWorktree = { A: { baseRef: 'origin/main' } }
    const root = await mount()

    await act(async () => {
      await latest?.refreshBranchCompare()
    })
    expect(mocks.beginGitBranchCompareRequest).toHaveBeenLastCalledWith(
      'A',
      expect.any(String),
      'origin/main',
      { preserveExistingSummary: true }
    )

    await act(async () => {
      root.render(<Probe compareBaseRef="origin/dev" />)
    })
    await act(async () => {
      await latest?.refreshBranchCompare()
    })
    expect(mocks.beginGitBranchCompareRequest).toHaveBeenLastCalledWith(
      'A',
      expect.any(String),
      'origin/dev'
    )
  })

  it('skips the git call for folder workspaces and when no compare base is resolved', async () => {
    await mount({ isFolder: true, isBranchVisible: true })
    await act(async () => {
      await latest?.refreshBranchCompare()
    })
    expect(mocks.getRuntimeGitBranchCompare).not.toHaveBeenCalled()

    await mount({ compareBaseRef: null, isBranchVisible: true })
    await act(async () => {
      await latest?.refreshBranchCompare()
    })
    expect(mocks.getRuntimeGitBranchCompare).not.toHaveBeenCalled()
  })

  it('keeps refreshBranchCompareRef pointed at the current closure across rerenders', async () => {
    const root = await mount({ compareBaseRef: 'origin/main' })
    await act(async () => {
      root.render(<Probe compareBaseRef="origin/dev" />)
    })

    await act(async () => {
      await latest?.refreshBranchCompareRef.current()
    })
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'A' }),
      'origin/dev'
    )
  })

  it('refreshes when HEAD moves on a visible branch', async () => {
    const root = await mount({ isBranchVisible: true, statusHead: 'head-1' })
    await flush()
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(<Probe isBranchVisible statusHead="head-2" />)
    })
    await flush()
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(2)
  })

  it('refreshes when the remote status moves without a HEAD change', async () => {
    const remote: GitUpstreamStatus = {
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 0,
      behind: 0
    }
    const root = await mount({ isBranchVisible: true, statusHead: 'head-1', remoteStatus: remote })
    await flush()
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(1)

    // A push moves the remote base and ahead count while local HEAD stays put.
    await act(async () => {
      root.render(
        <Probe isBranchVisible statusHead="head-1" remoteStatus={{ ...remote, ahead: 1 }} />
      )
    })
    await flush()
    expect(mocks.getRuntimeGitBranchCompare).toHaveBeenCalledTimes(2)
  })
})
