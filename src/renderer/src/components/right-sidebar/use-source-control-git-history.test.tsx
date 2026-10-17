// @vitest-environment happy-dom

import { act } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getRuntimeGitHistory: vi.fn() }))

vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitHistory: mocks.getRuntimeGitHistory
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))

import { useSourceControlGitHistory } from './source-control/sync/use-git-history'
import { deferred, flush, mountProbe, unmountProbes } from './source-control-hook-test-harness'
import type { GitHistoryResult } from '../../../../shared/git-history-types'

function historyResult(subject: string): GitHistoryResult {
  return {
    items: [{ id: subject, parentIds: [], subject, message: subject }],
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
  compareBaseRef?: string | null
  isFolder?: boolean
  isBranchVisible?: boolean
  isGitHistoryExpanded?: boolean
  isGitHistoryVisible?: boolean
  worktreeMap?: ReadonlyMap<string, unknown>
}): null {
  latest = useSourceControlGitHistory({
    activeRepoTarget: props.activeRepoTarget ?? { kind: 'local' },
    activeWorktreeId: props.worktreeId === undefined ? 'A' : props.worktreeId,
    worktreePath: props.worktreePath ?? '/a',
    compareBaseRef: props.compareBaseRef === undefined ? 'origin/main' : props.compareBaseRef,
    isFolder: props.isFolder ?? false,
    isBranchVisible: props.isBranchVisible ?? true,
    isGitHistoryExpanded: props.isGitHistoryExpanded ?? true,
    isGitHistoryVisible: props.isGitHistoryVisible ?? true,
    worktreeMap: props.worktreeMap ?? ALL_WORKTREES
  })
  return null
}

/** Mounts the probe; omitted props fall back to the defaults declared in `Probe`. */
async function mount(props: Parameters<typeof Probe>[0] = {}): Promise<Root> {
  return mountProbe(<Probe {...props} />)
}

beforeEach(() => {
  mocks.getRuntimeGitHistory.mockResolvedValue(historyResult('default'))
})

afterEach(() => {
  unmountProbes()
  vi.clearAllMocks()
  latest = null
})

describe('useSourceControlGitHistory stale completion', () => {
  it('defaults to all branches and discards pending pages when switching to Current branch', async () => {
    const page = deferred<GitHistoryResult>()
    mocks.getRuntimeGitHistory
      .mockResolvedValueOnce(firstPage())
      .mockReturnValueOnce(page.promise)
      .mockResolvedValueOnce(historyResult('current-only'))
    await mount()
    await flush()
    expect(latest?.gitHistoryScope).toBe('all')
    expect(mocks.getRuntimeGitHistory.mock.calls[0]?.[1]).toMatchObject({ scope: 'all' })
    void latest?.loadMoreGitHistory()
    await flush()
    await act(async () => {
      latest?.setGitHistoryScope('current')
    })
    await flush()
    expect(mocks.getRuntimeGitHistory.mock.calls[2]?.[1]).toMatchObject({
      scope: 'current',
      includeRelatedRefs: false
    })
    await act(async () => {
      page.resolve(historyResult('stale-all-branch-page'))
    })
    await flush()
    expect(latest?.gitHistoryState.result?.items.map((item) => item.id)).toEqual(['current-only'])
  })

  function firstPage(): GitHistoryResult {
    return {
      ...historyResult('first'),
      hasMore: true,
      nextCursor: { revisions: ['a'.repeat(40)], offset: 1 }
    }
  }

  it('appends older commits, retains graph metadata and deduplicates concurrent requests', async () => {
    const page = deferred<GitHistoryResult>()
    const first = { ...firstPage(), currentRef: { id: 'refs/heads/main', name: 'main' } }
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(first).mockReturnValueOnce(page.promise)
    await mount()
    await flush()
    void latest?.loadMoreGitHistory()
    void latest?.loadMoreGitHistory()
    await flush()
    expect(mocks.getRuntimeGitHistory).toHaveBeenCalledTimes(2)
    expect(latest?.gitHistoryState.isLoadingMore).toBe(true)
    expect(mocks.getRuntimeGitHistory.mock.calls[1]?.[1]).toEqual({
      limit: 50,
      cursor: first.nextCursor
    })
    await act(async () => {
      page.resolve(historyResult('second'))
    })
    await flush()
    expect(latest?.gitHistoryState.result?.items.map((item) => item.id)).toEqual([
      'first',
      'second'
    ])
    expect(latest?.gitHistoryState.result?.currentRef).toEqual(first.currentRef)
    expect(latest?.gitHistoryState.result?.hasMore).toBe(false)
  })

  it('keeps earlier commits on page failure and supports retry', async () => {
    mocks.getRuntimeGitHistory
      .mockResolvedValueOnce(firstPage())
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce(historyResult('older'))
    await mount()
    await flush()
    await act(async () => {
      await latest?.loadMoreGitHistory()
    })
    expect(latest?.gitHistoryState.loadMoreError).toBe('Offline')
    expect(latest?.gitHistoryState.result?.items).toEqual(firstPage().items)
    await act(async () => {
      await latest?.loadMoreGitHistory()
    })
    expect(latest?.gitHistoryState.result?.items).toHaveLength(2)
  })

  it('does not append a stale page after refresh', async () => {
    const page = deferred<GitHistoryResult>()
    mocks.getRuntimeGitHistory
      .mockResolvedValueOnce(firstPage())
      .mockReturnValueOnce(page.promise)
      .mockResolvedValueOnce(historyResult('fresh'))
    await mount()
    await flush()
    void latest?.loadMoreGitHistory()
    await flush()
    await act(async () => {
      await latest?.refreshGitHistory()
    })
    await act(async () => {
      page.resolve(historyResult('stale'))
    })
    await flush()
    expect(latest?.gitHistoryState.result?.items.map((item) => item.id)).toEqual(['fresh'])
  })

  it('does not repeatedly request the first page from an older execution host', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValue({ ...historyResult('old-host'), hasMore: true })
    await mount()
    await flush()
    await latest?.loadMoreGitHistory()
    expect(mocks.getRuntimeGitHistory).toHaveBeenCalledTimes(1)
  })

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
    // B has no cached history yet, so it must load rather than render A's commits.
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

  it('keeps the previous result while refreshing and reports errors alongside it', async () => {
    const first = deferred<GitHistoryResult>()
    const second = deferred<GitHistoryResult>()
    mocks.getRuntimeGitHistory
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    await mount()
    expect(latest?.gitHistoryState).toEqual({ status: 'loading' })
    await act(async () => {
      first.resolve(historyResult('from-a'))
    })
    await flush()

    void latest?.refreshGitHistory()
    await flush()
    expect(latest?.gitHistoryState).toEqual({
      status: 'refreshing',
      result: historyResult('from-a')
    })

    await act(async () => {
      second.reject(new Error('git log failed'))
    })
    await flush()
    expect(latest?.gitHistoryState).toEqual({
      status: 'error',
      result: historyResult('from-a'),
      error: 'git log failed'
    })
  })

  it('prunes history for worktrees that disappear and blocks their in-flight response', async () => {
    const a = deferred<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(a.promise)

    const root = await mount({ worktreeId: 'A', worktreePath: '/a' })
    // Worktree A is deleted while its history request is still running.
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
    // Exact empty state, not merely "different": the entry must be gone, not replaced.
    expect(latest?.gitHistoryState).toEqual({ status: 'idle' })
  })

  it('re-fetches when the compare base moves and passes it to the history read', async () => {
    const root = await mount({ compareBaseRef: 'origin/main' })
    await flush()
    expect(mocks.getRuntimeGitHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ worktreeId: 'A', worktreePath: '/a' }),
      { limit: 50, baseRef: 'origin/main', includeRelatedRefs: true, scope: 'all' }
    )

    await act(async () => {
      root.render(<Probe compareBaseRef="origin/dev" />)
    })
    await flush()
    expect(mocks.getRuntimeGitHistory).toHaveBeenCalledTimes(2)
    expect(mocks.getRuntimeGitHistory).toHaveBeenLastCalledWith(expect.anything(), {
      limit: 50,
      baseRef: 'origin/dev',
      includeRelatedRefs: true,
      scope: 'all'
    })
  })

  it('re-fetches when the owner host changes but the worktree and path stay put', async () => {
    const root = await mount({
      activeRepoTarget: { kind: 'local' }
    })
    await flush()
    expect(mocks.getRuntimeGitHistory).toHaveBeenCalledTimes(1)
    expect(mocks.getRuntimeGitHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { kind: 'local' } }),
      expect.anything()
    )

    await act(async () => {
      root.render(<Probe activeRepoTarget={{ kind: 'environment', environmentId: 'env-1' }} />)
    })
    await flush()
    expect(mocks.getRuntimeGitHistory).toHaveBeenCalledTimes(2)
    expect(mocks.getRuntimeGitHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { kind: 'environment', environmentId: 'env-1' } }),
      expect.anything()
    )

    // A new settings object with the same owner host must not trigger another git read.
    await act(async () => {
      root.render(<Probe activeRepoTarget={{ kind: 'environment', environmentId: 'env-1' }} />)
    })
    await flush()
    expect(mocks.getRuntimeGitHistory).toHaveBeenCalledTimes(2)
  })

  it('does not shell out to git while collapsed, hidden, or on a folder workspace', async () => {
    await mount({ isGitHistoryExpanded: false })
    await mount({ isGitHistoryVisible: false })
    await mount({ isBranchVisible: false })
    await flush()
    expect(mocks.getRuntimeGitHistory).not.toHaveBeenCalled()

    await mount({ isFolder: true })
    await act(async () => {
      await latest?.refreshGitHistory()
    })
    expect(mocks.getRuntimeGitHistory).not.toHaveBeenCalled()
  })
})
