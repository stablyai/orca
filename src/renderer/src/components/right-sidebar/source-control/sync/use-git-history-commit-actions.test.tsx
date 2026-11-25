// @vitest-environment happy-dom

import { act, useState } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GitBranchChangeEntry,
  GitCommitCompareResult
} from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitHistoryItem } from '../../../../../../shared/git/history/git-history-types'

const mocks = vi.hoisted(() => ({
  getRuntimeGitCommitCompare: vi.fn(),
  openCommitAllDiffs: vi.fn(),
  openCommitDiff: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/runtime/source-control/git/runtime-git-diff-client', () => ({
  getRuntimeGitCommitCompare: mocks.getRuntimeGitCommitCompare
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/source-control/git/runtime-git-working-tree-client', () => ({
  getRuntimeGitRemoteCommitUrl: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openCommitAllDiffs: mocks.openCommitAllDiffs,
      openCommitDiff: mocks.openCommitDiff
    })
  }
}))
vi.mock('../panel/worktree-scope', () => ({
  useSourceControlScope: () => null,
  sourceControlConnectionId: () => undefined
}))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: vi.fn()
}))
vi.mock('@/lib/agent-session/launch/shortcuts/agent-tab-shortcuts', () => ({
  resolveDefaultAgentForWorktreeNewTab: vi.fn()
}))
vi.mock('@/lib/agent-session/launch/inventory/agent-detection-target-inventory', () => ({
  getDetectionTargetIdentityForWorktree: vi.fn()
}))
vi.mock('@/lib/browser/workspace/workspace-browser-tab-open', () => ({
  openWorkspaceBrowserTab: vi.fn()
}))

import { useGitHistoryCommitActions } from './use-git-history-commit-actions'
import { COMMIT_COMPARE_JOIN_WINDOW_MS } from './git-history-commit-compare'
import { useChangeScopeSync } from '../panel/use-change-scope-sync'
import type { GitHistoryPanelState } from './git-history-page-store'
import {
  ALL_CHANGES_SCOPE,
  type SourceControlChangeScope,
  type SourceControlCommitScopeFiles
} from '../panel/change-scope'

const COMMIT: GitHistoryItem = { id: 'c1', parentIds: [], subject: 'c1', message: 'c1' }

function compare(
  path: string,
  commitOid = COMMIT.id,
  parentOid: string | null = 'p1'
): GitCommitCompareResult {
  return {
    summary: {
      commitOid,
      parentOid,
      compareRef: commitOid,
      baseRef: parentOid ?? 'empty tree',
      changedFiles: 1,
      status: 'ready'
    },
    entries: [{ path, status: 'modified' }]
  }
}

/** Gives every owner read its own deferred reply, so no dispatch is left without one. */
function deferCompareReads(): PromiseWithResolvers<GitCommitCompareResult>[] {
  const reads: PromiseWithResolvers<GitCommitCompareResult>[] = []
  mocks.getRuntimeGitCommitCompare.mockImplementation(() => {
    const read = Promise.withResolvers<GitCommitCompareResult>()
    reads.push(read)
    return read.promise
  })
  return reads
}

let latest: ReturnType<typeof useGitHistoryCommitActions> | null = null

function Probe({
  worktreeId,
  isSurfaceOpen
}: {
  worktreeId: string
  isSurfaceOpen?: () => boolean
}): null {
  latest = useGitHistoryCommitActions({
    activeWorktreeId: worktreeId,
    worktreePath: `/${worktreeId}`,
    activeRepoTarget: { kind: 'local' },
    resolveSplitTargetGroupId: () => undefined,
    isSurfaceOpen
  })
  return null
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.getRuntimeGitCommitCompare.mockReset()
  latest = null
})

describe('useGitHistoryCommitActions context fencing', () => {
  it('joins a reselected commit’s pending compare instead of reading it again', async () => {
    const reads = deferCompareReads()
    const other: GitHistoryItem = { id: 'c2', parentIds: [], subject: 'c2', message: 'c2' }
    render(<Probe worktreeId="A" />)
    const actions = latest!

    // Pick A, leave for another scope, then pick A again before the owner answers.
    const firstRead = actions.loadCommitFiles(COMMIT)
    const otherRead = actions.loadCommitFiles(other)
    const reselected = actions.loadCommitFiles(COMMIT)
    const opening = actions.openHistoryCommitDiff(COMMIT)
    expect(reads).toHaveLength(2)
    reads[0].resolve(compare('changed.ts'))
    reads[1].resolve(compare('other.ts', other.id))
    for (const read of reads.slice(2)) {
      read.resolve(compare('extra.ts'))
    }

    const changed = [{ path: 'changed.ts', status: 'modified' }]
    await otherRead
    expect(await firstRead).toEqual(changed)
    expect(await reselected).toEqual(changed)
    await opening
    expect(mocks.openCommitAllDiffs.mock.lastCall?.[3]).toEqual(changed)
  })

  it('reads a commit again once a deepened checkout shows its parent', async () => {
    const reads = deferCompareReads()
    // In a shallow checkout the boundary commit has no parents and compares against the empty tree.
    const shallow: GitHistoryItem = { id: 'a', parentIds: [], subject: 'a', message: 'a' }
    const deepened: GitHistoryItem = { ...shallow, parentIds: ['p0'] }
    const commitScope = (commit: GitHistoryItem): SourceControlChangeScope => ({
      kind: 'commit',
      commit,
      pickedBaseOid: null,
      pickedFromBranchPage: true
    })
    let files: SourceControlCommitScopeFiles | null = null
    const setCommitScopeFiles = (next: SourceControlCommitScopeFiles | null): void => {
      files = next
    }
    function ScopeProbe({ changeScope }: { changeScope: SourceControlChangeScope }): null {
      latest = useGitHistoryCommitActions({
        activeWorktreeId: 'A',
        worktreePath: '/A',
        activeRepoTarget: { kind: 'local' },
        resolveSplitTargetGroupId: () => undefined
      })
      useChangeScopeSync({
        changeScope,
        setChangeScope: () => {},
        setCommitScopeFiles,
        gitHistoryState: { status: 'idle' },
        statusHead: null,
        loadCommitFiles: latest.loadCommitFiles
      })
      return null
    }

    // A -> All changes -> (deepen) -> A, with the shallow reply still held.
    const root = render(<ScopeProbe changeScope={commitScope(shallow)} />)
    await act(async () => root.rerender(<ScopeProbe changeScope={ALL_CHANGES_SCOPE} />))
    await act(async () => root.rerender(<ScopeProbe changeScope={commitScope(deepened)} />))
    expect(reads).toHaveLength(2)

    await act(async () => {
      reads[0].resolve({
        ...compare('root.ts', 'a', null),
        entries: [
          { path: 'older.ts', status: 'added' },
          { path: 'root.ts', status: 'added' }
        ]
      })
      reads[1].resolve(compare('changed.ts', 'a', 'p0'))
      for (const read of reads.slice(2)) {
        read.resolve(compare('extra.ts', 'a', 'extra'))
      }
    })

    const changed: GitBranchChangeEntry[] = [{ path: 'changed.ts', status: 'modified' }]
    expect(files).toEqual({ commitId: 'a', status: 'ready', entries: changed })
    await latest!.openHistoryCommitDiff(deepened)
    expect(mocks.openCommitAllDiffs.mock.lastCall?.[2]).toMatchObject({ parentOid: 'p0' })
    expect(mocks.openCommitAllDiffs.mock.lastCall?.[3]).toEqual(changed)
    latest!.openCommitFile(deepened, changed[0])
    expect(mocks.openCommitDiff.mock.lastCall?.[3]).toMatchObject({ parentOid: 'p0' })
    // Same graph: reselecting A reuses the deepened compare.
    await act(async () => root.rerender(<ScopeProbe changeScope={ALL_CHANGES_SCOPE} />))
    await act(async () => root.rerender(<ScopeProbe changeScope={commitScope(deepened)} />))
    expect(reads).toHaveLength(2)
  })

  it('follows a held pick to its parents on a refreshed page after a deepen', async () => {
    const reads = deferCompareReads()
    const shallow: GitHistoryItem = { id: 'a', parentIds: [], subject: 'a', message: 'a' }
    const deepened: GitHistoryItem = { ...shallow, parentIds: ['p0'] }
    let files: SourceControlCommitScopeFiles | null = null
    const setCommitScopeFiles = (next: SourceControlCommitScopeFiles | null): void => {
      files = next
    }
    let picked: SourceControlChangeScope | null = null
    function HeldPickProbe({ gitHistoryState }: { gitHistoryState: GitHistoryPanelState }): null {
      const [changeScope, setChangeScope] = useState<SourceControlChangeScope>({
        kind: 'commit',
        commit: shallow,
        pickedBaseOid: null,
        pickedFromBranchPage: false
      })
      picked = changeScope
      latest = useGitHistoryCommitActions({
        activeWorktreeId: 'A',
        worktreePath: '/A',
        activeRepoTarget: { kind: 'local' },
        resolveSplitTargetGroupId: () => undefined
      })
      useChangeScopeSync({
        changeScope,
        setChangeScope,
        setCommitScopeFiles,
        gitHistoryState,
        statusHead: null,
        loadCommitFiles: latest.loadCommitFiles
      })
      return null
    }

    // Picked from the shallow page (or the old page still shown while the menu refreshes).
    const root = render(<HeldPickProbe gitHistoryState={{ status: 'idle' }} />)
    await act(async () => reads[0].resolve(compare('root.ts', 'a', null)))
    expect(reads).toHaveLength(1)
    // The checkout is deepened and the refreshed page shows the commit's parent.
    const page = {
      items: [deepened],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit: 50
    }
    await act(async () =>
      root.rerender(<HeldPickProbe gitHistoryState={{ status: 'ready', result: page }} />)
    )
    expect(reads).toHaveLength(2)
    await act(async () => {
      reads[1].resolve(compare('changed.ts', 'a', 'p0'))
      for (const read of reads.slice(2)) {
        read.resolve(compare('extra.ts', 'a', 'extra'))
      }
    })

    const changed: GitBranchChangeEntry[] = [{ path: 'changed.ts', status: 'modified' }]
    expect(files).toEqual({ commitId: 'a', status: 'ready', entries: changed })
    expect(picked).toMatchObject({ commit: deepened })
    await latest!.openHistoryCommitDiff(deepened)
    expect(mocks.openCommitAllDiffs.mock.lastCall?.[2]).toMatchObject({ parentOid: 'p0' })
  })

  it('replaces a compare that outlived the owner timeout when the commit is reselected', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    mocks.getRuntimeGitCommitCompare
      .mockReturnValueOnce(new Promise<GitCommitCompareResult>(() => {}))
      .mockResolvedValueOnce(compare('fresh.ts'))
    render(<Probe worktreeId="A" />)
    const actions = latest!

    void actions.loadCommitFiles(COMMIT)
    clock.mockReturnValue(1_000 + COMMIT_COMPARE_JOIN_WINDOW_MS)
    const reselected = actions.loadCommitFiles(COMMIT)

    expect(mocks.getRuntimeGitCommitCompare).toHaveBeenCalledTimes(2)
    await expect(reselected).resolves.toEqual([{ path: 'fresh.ts', status: 'modified' }])
    clock.mockRestore()
  })

  it('reports a shared compare failure to every waiter and reads again afterwards', async () => {
    const pending = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare.mockReturnValueOnce(pending.promise)
    render(<Probe worktreeId="A" />)
    const actions = latest!

    const loading = actions.loadCommitFiles(COMMIT)
    const opening = actions.openHistoryCommitDiff(COMMIT)
    pending.reject(new Error('Commit compare failed'))

    await expect(loading).rejects.toThrow('Commit compare failed')
    await opening
    expect(mocks.openCommitAllDiffs).not.toHaveBeenCalled()
    expect(mocks.toastError.mock.lastCall?.[0]).toBe('Commit compare failed')

    mocks.getRuntimeGitCommitCompare.mockResolvedValueOnce(compare('recovered.ts'))
    await actions.openHistoryCommitDiff(COMMIT)
    expect(mocks.openCommitAllDiffs.mock.lastCall?.[3]).toEqual([
      { path: 'recovered.ts', status: 'modified' }
    ])
    expect(mocks.getRuntimeGitCommitCompare).toHaveBeenCalledTimes(2)
  })

  it('opens a pending diff after switching away from a still-open Graph', async () => {
    const pending = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare.mockReturnValueOnce(pending.promise)
    const root = render(<Probe worktreeId="A" isSurfaceOpen={() => true} />)
    const opening = latest!.openHistoryCommitDiff(COMMIT)
    // Another editor tab became active, which unmounts the Graph view without closing it.
    root.unmount()
    pending.resolve(compare('kept.ts'))
    await opening

    expect(mocks.openCommitAllDiffs.mock.lastCall?.[3]).toEqual([
      { path: 'kept.ts', status: 'modified' }
    ])
  })

  it('shows a pending error after switching away from a still-open Graph', async () => {
    const pending = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare.mockReturnValueOnce(pending.promise)
    const root = render(<Probe worktreeId="A" isSurfaceOpen={() => true} />)
    const opening = latest!.openHistoryCommitDiff(COMMIT)
    root.unmount()
    pending.reject(new Error('Compare failed'))
    await opening

    expect(mocks.toastError).toHaveBeenCalledWith('Compare failed')
  })

  it('drops a pending diff and its error once the Graph closes', async () => {
    let graphOpen = true
    const success = Promise.withResolvers<GitCommitCompareResult>()
    const failure = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare
      .mockReturnValueOnce(success.promise)
      .mockReturnValueOnce(failure.promise)
    const root = render(<Probe worktreeId="A" isSurfaceOpen={() => graphOpen} />)
    const opening = latest!.openHistoryCommitDiff(COMMIT)
    const failing = latest!.openHistoryCommitDiff({ ...COMMIT, id: 'c2' })
    root.unmount()
    graphOpen = false
    success.resolve(compare('closed.ts'))
    failure.reject(new Error('Closed Graph failure'))
    await Promise.all([opening, failing])

    expect(mocks.openCommitAllDiffs).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('keeps the reopened Graph diff when the earlier Graph view settles later', async () => {
    const first = Promise.withResolvers<GitCommitCompareResult>()
    const fresh = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(fresh.promise)
    const root = render(<Probe worktreeId="A" />)
    const original = latest!
    // The earlier view's open and file load share one read.
    const oldOpen = original.openHistoryCommitDiff(COMMIT)
    const oldFiles = original.loadCommitFiles(COMMIT)
    root.unmount()

    render(<Probe worktreeId="A" />)
    const newOpen = latest!.openHistoryCommitDiff(COMMIT)
    fresh.resolve(compare('fresh.ts', COMMIT.id, 'fresh-parent'))
    await newOpen
    first.resolve(compare('first.ts', COMMIT.id, 'first-parent'))
    await Promise.all([oldOpen, oldFiles])

    expect(mocks.openCommitAllDiffs.mock.lastCall?.[2]).toMatchObject({
      parentOid: 'fresh-parent'
    })
    expect(mocks.openCommitAllDiffs.mock.lastCall?.[3]).toEqual([
      { path: 'fresh.ts', status: 'modified' }
    ])
  })

  it('ignores a departed owner error and opens a later live retry', async () => {
    const departed = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare.mockReturnValueOnce(departed.promise)
    const root = render(<Probe worktreeId="A" />)
    const original = latest!
    const oldOpen = original.openHistoryCommitDiff(COMMIT)
    const oldFiles = original.loadCommitFiles(COMMIT).catch(() => undefined)
    await act(async () => root.rerender(<Probe worktreeId="B" />))
    departed.reject(new Error('Departed owner unavailable'))
    await Promise.all([oldOpen, oldFiles])

    mocks.getRuntimeGitCommitCompare.mockRejectedValueOnce(new Error('Current owner unavailable'))
    await latest!.openHistoryCommitDiff(COMMIT)
    expect(mocks.toastError.mock.calls.map(([message]) => message)).toEqual([
      'Current owner unavailable'
    ])

    mocks.getRuntimeGitCommitCompare.mockResolvedValueOnce(compare('recovered.ts'))
    await latest!.openHistoryCommitDiff(COMMIT)
    expect(mocks.openCommitAllDiffs.mock.lastCall?.[3]).toEqual([
      { path: 'recovered.ts', status: 'modified' }
    ])
  })

  it('keeps a late compare for the previous worktree out of the current cache', async () => {
    const fromA = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare.mockReturnValueOnce(fromA.promise)
    const root = render(<Probe worktreeId="A" />)
    const loadA = latest!.loadCommitFiles(COMMIT)

    await act(async () => {
      root.rerender(<Probe worktreeId="B" />)
    })
    await act(async () => {
      fromA.resolve(compare('from-a.ts'))
    })
    await loadA

    mocks.getRuntimeGitCommitCompare.mockResolvedValueOnce(compare('from-b.ts'))
    await expect(latest!.loadCommitFiles(COMMIT)).resolves.toEqual([
      { path: 'from-b.ts', status: 'modified' }
    ])
  })

  it('drops an Open diff whose load finishes after a worktree switch', async () => {
    const fromA = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare.mockReturnValueOnce(fromA.promise)
    const root = render(<Probe worktreeId="A" />)
    const opening = latest!.openHistoryCommitDiff(COMMIT)

    await act(async () => {
      root.rerender(<Probe worktreeId="B" />)
    })
    await act(async () => {
      fromA.resolve(compare('from-a.ts'))
    })
    await opening
    await act(() => Promise.resolve())

    expect(mocks.openCommitAllDiffs).not.toHaveBeenCalled()
  })
})
