// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRuntimeGitBranchCompare: vi.fn(),
  beginGitBranchCompareRequest: vi.fn(),
  setGitBranchCompareResult: vi.fn(),
  clearGitBranchCompare: vi.fn(),
  gitBranchCompareSummaryByWorktree: {} as Record<
    string,
    { baseRef: string; status?: string } | undefined
  >
}))

vi.mock('@/runtime/runtime-git-diff-client', () => ({
  getRuntimeGitBranchCompare: mocks.getRuntimeGitBranchCompare
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))
vi.mock('@/store/index', () => {
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

import { useSourceControlBranchCompare } from './use-branch-compare'
import {
  deferred,
  flush,
  mountProbe,
  unmountProbes
} from '../panel/source-control-hook-test-harness'
import type { GitBranchCompareResult } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitUpstreamStatus } from '../../../../../../shared/git/status/git-status-types'

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
    activeRepoTarget: { kind: 'local' },
    activeWorktreeId: props.worktreeId === undefined ? 'A' : props.worktreeId,
    worktreePath: '/a',
    compareBaseRef: props.compareBaseRef === undefined ? 'origin/main' : props.compareBaseRef,
    isFolder: props.isFolder ?? false,
    branchName: 'feature',
    // Default to explicit refreshes; effect-triggered refreshes have separate cases.
    isBranchVisible: props.isBranchVisible ?? false,
    activeGitStatusHead: props.statusHead ?? null,
    remoteStatus: props.remoteStatus
  })
  return null
}

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
  // resetAllMocks also clears unused once queues; beforeEach restores defaults.
  vi.resetAllMocks()
  mocks.gitBranchCompareSummaryByWorktree = {}
  latest = null
})

describe('useSourceControlBranchCompare scheduler', () => {
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
})
