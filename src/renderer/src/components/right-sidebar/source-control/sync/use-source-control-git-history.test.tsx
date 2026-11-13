// @vitest-environment happy-dom

import { act } from 'react'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getRuntimeGitHistory: vi.fn() }))

vi.mock('@/runtime/source-control/git/runtime-git-status-client', () => ({
  getRuntimeGitHistory: mocks.getRuntimeGitHistory
}))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: () => undefined
}))

import { useSourceControlGitHistory } from './use-git-history'
import {
  deferred,
  flush,
  mountProbe,
  unmountProbes
} from '../panel/source-control-hook-test-harness'
import type { GitHistoryResult } from '../../../../../../shared/git/history/git-history-types'

function historyResult(subject: string, headOid?: string): GitHistoryResult {
  return {
    items: [{ id: subject, parentIds: [], subject, message: subject }],
    ...(headOid ? { currentRef: { id: 'refs/heads/main', name: 'main', revision: headOid } } : {}),
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: false,
    limit: 50
  }
}

const ALL_WORKTREES = new Map<string, unknown>([
  ['A', {}],
  ['B', {}]
])

type Api = ReturnType<typeof useSourceControlGitHistory>

let latest: Api | null = null

function Probe(props: {
  activeRepoTarget?: RuntimeClientTarget
  worktreeId?: string | null
  worktreePath?: string
  branchName?: string
  compareBaseRef?: string | null
  compareBaseOid?: string | null
  isFolder?: boolean
  isBranchVisible?: boolean
  headOid?: string | null
  headUnknown?: boolean
  isGitHistoryNeeded?: boolean
  isGitHistoryVisible?: boolean
  worktreeMap?: ReadonlyMap<string, unknown>
}): null {
  latest = useSourceControlGitHistory({
    activeRepoTarget: props.activeRepoTarget ?? { kind: 'local' },
    activeWorktreeId: props.worktreeId === undefined ? 'A' : props.worktreeId,
    worktreePath: props.worktreePath ?? '/a',
    branchName: props.branchName ?? 'main',
    compareBaseRef: props.compareBaseRef === undefined ? 'origin/main' : props.compareBaseRef,
    compareBaseOid: props.compareBaseOid ?? null,
    headOid: props.headUnknown ? undefined : (props.headOid ?? null),
    isFolder: props.isFolder ?? false,
    isBranchVisible: props.isBranchVisible ?? true,
    isGitHistoryNeeded: props.isGitHistoryNeeded ?? true,
    isGitHistoryVisible: props.isGitHistoryVisible ?? true,
    worktreeMap: props.worktreeMap ?? ALL_WORKTREES
  })
  return null
}

async function mount(props: Parameters<typeof Probe>[0] = {}): Promise<Root> {
  return mountProbe(<Probe {...props} />)
}

beforeEach(() => {
  mocks.getRuntimeGitHistory.mockResolvedValue(historyResult('default'))
})

afterEach(async () => {
  // History is a session cache; an empty worktree map prunes it between tests.
  await mount({ worktreeId: null, worktreeMap: new Map() })
  unmountProbes()
  vi.clearAllMocks()
  latest = null
})

describe('useSourceControlGitHistory stale completion', () => {
  it('drops a stale response for a worktree the user already left and returned to', async () => {
    const firstA = deferred<GitHistoryResult>()
    const b = deferred<GitHistoryResult>()
    const secondA = deferred<GitHistoryResult>()
    mocks.getRuntimeGitHistory
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(secondA.promise)

    const root = await mount({ worktreeId: 'A', worktreePath: '/a' })
    await act(async () => {
      root.render(<Probe worktreeId="B" worktreePath="/b" />)
    })
    await act(async () => {
      root.render(<Probe worktreeId="A" worktreePath="/a" />)
    })
    await flush()
    expect(mocks.getRuntimeGitHistory).toHaveBeenCalledTimes(3)

    await act(async () => {
      secondA.resolve(historyResult('current-a'))
    })
    await flush()
    await act(async () => {
      firstA.resolve(historyResult('stale-a'))
      b.resolve(historyResult('from-b'))
    })
    await flush()

    expect(latest?.gitHistoryState).toEqual({ status: 'ready', result: historyResult('current-a') })
  })

  it('never shows the previous worktree history after a switch', async () => {
    const a = deferred<GitHistoryResult>()
    const b = deferred<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)

    const root = await mount({ worktreeId: 'A', worktreePath: '/a' })
    await act(async () => {
      a.resolve(historyResult('from-a'))
    })
    await flush()
    expect(latest?.gitHistoryState).toEqual({ status: 'ready', result: historyResult('from-a') })

    await act(async () => {
      root.render(<Probe worktreeId="B" worktreePath="/b" />)
    })
    await flush()
    expect(latest?.gitHistoryState).toEqual({ status: 'loading' })

    await act(async () => {
      b.resolve(historyResult('from-b'))
    })
    await flush()
    expect(latest?.gitHistoryState).toEqual({ status: 'ready', result: historyResult('from-b') })
  })

  it('does not let a stale error overwrite the current worktree state', async () => {
    const firstA = deferred<GitHistoryResult>()
    const b = deferred<GitHistoryResult>()
    const secondA = deferred<GitHistoryResult>()
    mocks.getRuntimeGitHistory
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(secondA.promise)

    const root = await mount({ worktreeId: 'A', worktreePath: '/a' })
    await act(async () => {
      root.render(<Probe worktreeId="B" worktreePath="/b" />)
    })
    await act(async () => {
      root.render(<Probe worktreeId="A" worktreePath="/a" />)
    })
    await act(async () => {
      secondA.resolve(historyResult('current-a'))
    })
    await flush()
    await act(async () => {
      firstA.reject(new Error('stale worktree failed'))
      b.reject(new Error('b failed'))
    })
    await flush()

    expect(latest?.gitHistoryState).toEqual({ status: 'ready', result: historyResult('current-a') })
  })

  it('prunes history for worktrees that disappear and blocks their in-flight response', async () => {
    const a = deferred<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(a.promise)

    const root = await mount({ worktreeId: 'A', worktreePath: '/a' })
    const withoutA = new Map<string, unknown>([['B', {}]])
    await act(async () => {
      root.render(<Probe worktreeId="A" worktreePath="/a" worktreeMap={withoutA} />)
    })
    await act(async () => {
      a.resolve(historyResult('from-deleted-a'))
    })
    await flush()

    // Re-adding the id must not resurrect the pruned (or late) result.
    await act(async () => {
      root.render(<Probe worktreeId="A" worktreePath="/a" worktreeMap={ALL_WORKTREES} />)
    })
    expect(latest?.gitHistoryState).toEqual({ status: 'idle' })
  })
})

function branchPage(subject: string, headOid: string, baseOid: string): GitHistoryResult {
  return {
    ...historyResult(subject, headOid),
    branch: {
      baseRef: { id: 'refs/remotes/origin/main', name: 'origin/main', revision: baseOid },
      ahead: 1,
      behind: 0,
      unpushed: 1
    }
  }
}

describe('useSourceControlGitHistory session page', () => {
  it('shows the last page at once on remount while it refreshes', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(historyResult('first', 'h1'))
    await mount({ headOid: 'h1' })
    await flush()
    unmountProbes()

    mocks.getRuntimeGitHistory.mockReturnValueOnce(deferred<GitHistoryResult>().promise)
    await mount({ headOid: 'h1' })
    await flush()
    expect(latest?.gitHistoryState).toEqual({
      status: 'refreshing',
      result: historyResult('first', 'h1')
    })
  })

  it('shows a resolved no-base page, and loading only while HEAD is unknown', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValue(historyResult('recent', 'h1'))
    const root = await mount({ headOid: 'h1', compareBaseRef: null })
    await flush()
    expect(latest?.gitHistoryState).toEqual({
      status: 'ready',
      result: historyResult('recent', 'h1')
    })

    await act(async () => {
      root.render(<Probe headUnknown compareBaseRef={null} />)
    })
    expect(latest?.gitHistoryState).toEqual({ status: 'loading' })
  })

  it('never shows a page for another HEAD, base OID or host', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(branchPage('first', 'h1', 'b1'))
    const root = await mount({ headOid: 'h1', compareBaseOid: 'b1' })
    await flush()
    expect(latest?.gitHistoryState.result).toEqual(branchPage('first', 'h1', 'b1'))

    mocks.getRuntimeGitHistory.mockReturnValue(deferred<GitHistoryResult>().promise)
    await act(async () => {
      root.render(<Probe headOid="h2" compareBaseOid="b1" />)
    })
    expect(latest?.gitHistoryState).toEqual({ status: 'loading' })

    // Same base name and HEAD, but the base moved (fetch): the range changed.
    await act(async () => {
      root.render(<Probe headOid="h1" compareBaseOid="b2" />)
    })
    expect(latest?.gitHistoryState).toEqual({ status: 'loading' })

    await act(async () => {
      root.render(
        <Probe
          headOid="h1"
          compareBaseOid="b1"
          activeRepoTarget={{ kind: 'environment', environmentId: 'other-host' }}
        />
      )
    })
    expect(latest?.gitHistoryState).toEqual({ status: 'loading' })
  })

  it('keeps the newer page when an unmounted instance completes late', async () => {
    const older = deferred<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(older.promise)
    await mount({ headOid: 'h1' })
    unmountProbes()

    mocks.getRuntimeGitHistory.mockResolvedValueOnce(historyResult('newer', 'h1'))
    await mount({ headOid: 'h1' })
    await flush()
    await act(async () => {
      older.resolve(historyResult('older', 'h1'))
    })
    await flush()

    expect(latest?.gitHistoryState).toEqual({
      status: 'ready',
      result: historyResult('newer', 'h1')
    })
  })
})
