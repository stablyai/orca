// @vitest-environment happy-dom

import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitCommitCompareResult } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitHistoryItem } from '../../../../../../shared/git/history/git-history-types'

const mocks = vi.hoisted(() => ({
  getRuntimeGitCommitCompare: vi.fn(),
  openCommitAllDiffs: vi.fn(),
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
  useAppStore: { getState: () => ({ openCommitAllDiffs: mocks.openCommitAllDiffs }) }
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

const COMMIT: GitHistoryItem = { id: 'c1', parentIds: [], subject: 'c1', message: 'c1' }

function compare(path: string, commitOid = COMMIT.id, parentOid = 'p1'): GitCommitCompareResult {
  return {
    summary: {
      commitOid,
      parentOid,
      compareRef: commitOid,
      baseRef: parentOid,
      changedFiles: 1,
      status: 'ready'
    },
    entries: [{ path, status: 'modified' }]
  }
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
  latest = null
})

describe('useGitHistoryCommitActions context fencing', () => {
  it('opens the files accepted by the latest read of a reselected commit', async () => {
    const older = Promise.withResolvers<GitCommitCompareResult>()
    const newer = Promise.withResolvers<GitCommitCompareResult>()
    const other: GitHistoryItem = { id: 'c2', parentIds: [], subject: 'c2', message: 'c2' }
    mocks.getRuntimeGitCommitCompare
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(compare('other.ts', other.id))
      .mockReturnValueOnce(newer.promise)
    render(<Probe worktreeId="A" />)
    const actions = latest!

    const firstRead = actions.loadCommitFiles(COMMIT)
    await actions.loadCommitFiles(other)
    const latestRead = actions.loadCommitFiles(COMMIT)
    newer.resolve(compare('changed.ts'))
    const acceptedFiles = await latestRead
    older.resolve(compare('shallow.ts'))
    await firstRead

    await actions.openHistoryCommitDiff(COMMIT)
    expect(acceptedFiles).toEqual([{ path: 'changed.ts', status: 'modified' }])
    expect(mocks.openCommitAllDiffs.mock.lastCall?.[3]).toEqual(acceptedFiles)
  })

  it.each([true, false])(
    'reports the authoritative Graph Open failure when newer settles first is %s',
    async (newerFirst) => {
      const older = Promise.withResolvers<GitCommitCompareResult>()
      const newer = Promise.withResolvers<GitCommitCompareResult>()
      mocks.getRuntimeGitCommitCompare
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise)
      render(<Probe worktreeId="A" />)
      const actions = latest!

      const opening = actions.openHistoryCommitDiff(COMMIT)
      const current = actions.loadCommitFiles(COMMIT).catch(() => undefined)
      if (newerFirst) {
        newer.reject(new Error('Current commit compare failed'))
        await current
        older.resolve(compare('shallow.ts'))
      } else {
        older.resolve(compare('shallow.ts'))
        await act(() => Promise.resolve())
        newer.reject(new Error('Current commit compare failed'))
        await current
      }

      await opening
      expect(mocks.openCommitAllDiffs).not.toHaveBeenCalled()
      expect(mocks.toastError.mock.lastCall?.[0]).toBe('Current commit compare failed')

      mocks.getRuntimeGitCommitCompare.mockResolvedValueOnce(compare('recovered.ts'))
      await actions.openHistoryCommitDiff(COMMIT)
      expect(mocks.openCommitAllDiffs.mock.lastCall?.[3]).toEqual([
        { path: 'recovered.ts', status: 'modified' }
      ])
    }
  )

  it('opens the authoritative Graph result when a joined older compare rejects', async () => {
    const older = Promise.withResolvers<GitCommitCompareResult>()
    const newer = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    render(<Probe worktreeId="A" />)
    const actions = latest!

    const oldFiles = actions.loadCommitFiles(COMMIT).catch(() => undefined)
    const opening = actions.openHistoryCommitDiff(COMMIT)
    const current = actions.loadCommitFiles(COMMIT)
    newer.resolve(compare('current.ts'))
    await current
    older.reject(new Error('Superseded commit compare failed'))

    await Promise.all([oldFiles, opening])
    expect(mocks.openCommitAllDiffs.mock.lastCall?.[3]).toEqual([
      { path: 'current.ts', status: 'modified' }
    ])
    expect(mocks.toastError).not.toHaveBeenCalled()
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
    const retired = Promise.withResolvers<GitCommitCompareResult>()
    const fresh = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(retired.promise)
      .mockReturnValueOnce(fresh.promise)
    const root = render(<Probe worktreeId="A" />)
    const original = latest!
    const oldOpen = original.openHistoryCommitDiff(COMMIT)
    const oldFiles = original.loadCommitFiles(COMMIT)
    root.unmount()

    render(<Probe worktreeId="A" />)
    const newOpen = latest!.openHistoryCommitDiff(COMMIT)
    fresh.resolve(compare('fresh.ts', COMMIT.id, 'fresh-parent'))
    await newOpen
    retired.resolve(compare('retired.ts', COMMIT.id, 'retired-parent'))
    await Promise.all([oldOpen, oldFiles])
    first.resolve(compare('first.ts', COMMIT.id, 'first-parent'))

    expect(mocks.openCommitAllDiffs.mock.lastCall?.[2]).toMatchObject({
      parentOid: 'fresh-parent'
    })
    expect(mocks.openCommitAllDiffs.mock.lastCall?.[3]).toEqual([
      { path: 'fresh.ts', status: 'modified' }
    ])
  })

  it('ignores a departed owner error and opens a later live retry', async () => {
    const first = Promise.withResolvers<GitCommitCompareResult>()
    const departed = Promise.withResolvers<GitCommitCompareResult>()
    mocks.getRuntimeGitCommitCompare
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(departed.promise)
    const root = render(<Probe worktreeId="A" />)
    const original = latest!
    const oldOpen = original.openHistoryCommitDiff(COMMIT)
    const oldFiles = original.loadCommitFiles(COMMIT).catch(() => undefined)
    await act(async () => root.rerender(<Probe worktreeId="B" />))
    departed.reject(new Error('Departed owner unavailable'))
    await Promise.all([oldOpen, oldFiles])
    first.resolve(compare('first.ts'))

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
