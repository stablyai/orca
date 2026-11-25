// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { GitHistoryResult } from '../../../../../../shared/git/history/git-history-types'
import { Probe, mount, historyResult, mocks, historyProbe } from './git-history-hook-test-harness'

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
  it.each([
    { id: 'h1', name: 'h1', revision: 'h1', category: 'commits' },
    { id: 'refs/heads/other', name: 'other', revision: 'h1', category: 'branches' }
  ] satisfies NonNullable<GitHistoryResult['currentRef']>[])(
    'settles a mismatched history reply from $name as an error and can retry',
    async (currentRef) => {
      const matching = historyResult('current commit', 'h1')
      mocks.getRuntimeGitHistory
        .mockResolvedValueOnce({ ...historyResult('wrong context', 'h1'), currentRef })
        .mockResolvedValueOnce(matching)
      mount({ branchName: 'main', headOid: 'h1', compareBaseRef: null })
      await act(() => Promise.resolve())

      expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'error' })

      await act(async () => historyProbe.current?.refreshGitHistory())
      expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'ready', result: matching })
    }
  )

  it('settles an unborn HEAD as an empty page when status reports (initial)', async () => {
    const emptyPage: GitHistoryResult = { ...historyResult('unused'), items: [] }
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(emptyPage)
    mount({ headOid: '(initial)', compareBaseRef: null })
    await act(() => Promise.resolve())

    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'ready', result: emptyPage })
  })

  it('fences branch and recent history in both directions when two branches share a tip', async () => {
    const ranged = {
      ...branchPage('feature commit', 'h1', 'b1'),
      currentRef: { id: 'refs/heads/feature', name: 'feature', revision: 'h1' }
    }
    const recent = historyResult('recent commit', 'h1')
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(ranged)
    const root = mount({ branchName: 'feature', headOid: 'h1', compareBaseOid: 'b1' })
    await act(() => Promise.resolve())
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'ready', result: ranged })

    const ontoBase = Promise.withResolvers<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(ontoBase.promise)
    await act(async () =>
      root.rerender(<Probe branchName="main" headOid="h1" compareBaseOid="b1" />)
    )
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })
    await act(async () => ontoBase.resolve(recent))
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'ready', result: recent })

    const offBase = Promise.withResolvers<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(offBase.promise)
    await act(async () =>
      root.rerender(<Probe branchName="feature" headOid="h1" compareBaseOid="b1" />)
    )
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })
    await act(async () => offBase.resolve(ranged))
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'ready', result: ranged })
  })

  it('shows the last page at once on remount while it refreshes', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(historyResult('first', 'h1'))
    mount({ headOid: 'h1' })
    await act(() => Promise.resolve())
    cleanup()

    mocks.getRuntimeGitHistory.mockReturnValueOnce(
      Promise.withResolvers<GitHistoryResult>().promise
    )
    mount({ headOid: 'h1' })
    await act(() => Promise.resolve())
    expect(historyProbe.current?.gitHistoryState).toEqual({
      status: 'refreshing',
      result: historyResult('first', 'h1')
    })
  })

  it('shows a resolved no-base page, and loading only while HEAD is unknown', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValue(historyResult('recent', 'h1'))
    const root = mount({ headOid: 'h1', compareBaseRef: null })
    await act(() => Promise.resolve())
    expect(historyProbe.current?.gitHistoryState).toEqual({
      status: 'ready',
      result: historyResult('recent', 'h1')
    })

    await act(async () => {
      root.rerender(<Probe headUnknown compareBaseRef={null} />)
    })
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })
  })

  it('never shows a page for another HEAD, base OID or host', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(branchPage('first', 'h1', 'b1'))
    const root = mount({ headOid: 'h1', compareBaseOid: 'b1' })
    await act(() => Promise.resolve())
    expect(historyProbe.current?.gitHistoryState.result).toEqual(branchPage('first', 'h1', 'b1'))

    mocks.getRuntimeGitHistory.mockReturnValue(Promise.withResolvers<GitHistoryResult>().promise)
    await act(async () => {
      root.rerender(<Probe headOid="h2" compareBaseOid="b1" />)
    })
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })

    // Same base name and HEAD, but the base moved (fetch): the range changed.
    await act(async () => {
      root.rerender(<Probe headOid="h1" compareBaseOid="b2" />)
    })
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })

    await act(async () => {
      root.rerender(<Probe headOid="h1" compareBaseOid={null} />)
    })
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })

    await act(async () => {
      root.rerender(
        <Probe
          headOid="h1"
          compareBaseOid="b1"
          activeRepoTarget={{ kind: 'environment', environmentId: 'other-host' }}
        />
      )
    })
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })
  })

  it('hides an empty branch page once the base moves under an unchanged HEAD, even if the refresh fails or lands late', async () => {
    const initial = branchPage('x', 'h1', 'b1')
    const emptyOnB1: GitHistoryResult = {
      ...initial,
      items: [],
      branch: { ...initial.branch!, ahead: 0, unpushed: 0 }
    }
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(emptyOnB1)
    const root = mount({ headOid: 'h1', compareBaseOid: 'b1' })
    await act(() => Promise.resolve())
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'ready', result: emptyOnB1 })

    // Fetch moved origin/main (same name, same HEAD): the branch is now 1 ahead.
    const failed = Promise.withResolvers<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(failed.promise)
    await act(async () => {
      root.rerender(<Probe headOid="h1" compareBaseOid="b2" />)
    })
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })
    await act(async () => {
      failed.reject(new Error('offline'))
    })
    await act(() => Promise.resolve())
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'error', error: 'offline' })

    const late = Promise.withResolvers<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(late.promise)
    void historyProbe.current?.refreshGitHistory()
    await act(() => Promise.resolve())
    expect(historyProbe.current?.gitHistoryState.result).toBeUndefined()
    await act(async () => {
      late.resolve(branchPage('ahead', 'h1', 'b2'))
    })
    await act(() => Promise.resolve())
    expect(historyProbe.current?.gitHistoryState).toEqual({
      status: 'ready',
      result: branchPage('ahead', 'h1', 'b2')
    })
  })

  it('keeps the newer page when an unmounted instance completes late', async () => {
    const older = Promise.withResolvers<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(older.promise)
    mount({ headOid: 'h1' })
    cleanup()

    mocks.getRuntimeGitHistory.mockResolvedValueOnce(historyResult('newer', 'h1'))
    mount({ headOid: 'h1' })
    await act(() => Promise.resolve())
    await act(async () => {
      older.resolve(historyResult('older', 'h1'))
    })
    await act(() => Promise.resolve())

    expect(historyProbe.current?.gitHistoryState).toEqual({
      status: 'ready',
      result: historyResult('newer', 'h1')
    })
  })

  it('keeps a sibling section request when another section has a smaller worktree map', async () => {
    const pending = Promise.withResolvers<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(pending.promise)
    mount({ worktreeId: 'A', worktreePath: '/a', worktreeMap: new Map([['A', {}]]) })
    mount({ worktreeId: 'B', worktreePath: '/b', worktreeMap: new Map([['B', {}]]) })
    await act(async () => pending.resolve(historyResult('section-a')))
    expect(historyProbe.current?.gitHistoryState.result?.items[0].subject).toBe('section-a')
  })

  it('lets both execution owners publish for the same worktree ID', async () => {
    const local = Promise.withResolvers<GitHistoryResult>()
    const remote = Promise.withResolvers<GitHistoryResult>()
    mocks.getRuntimeGitHistory
      .mockReturnValueOnce(local.promise)
      .mockReturnValueOnce(remote.promise)
    mount({ worktreeId: 'A', headOid: 'h1' })
    mount({
      worktreeId: 'A',
      headOid: 'h1',
      activeRepoTarget: { kind: 'environment', environmentId: 'other-host' }
    })

    await act(async () => local.resolve(historyResult('local commit', 'h1')))
    expect(historyProbe.current?.gitHistoryState.result?.items[0].subject).toBe('local commit')
    await act(async () => remote.resolve(historyResult('remote commit', 'h1')))
    expect(historyProbe.current?.gitHistoryState.result?.items[0].subject).toBe('remote commit')
  })
})

describe('plain history base context', () => {
  it('hides an old-host page when a different base resolves and the new request fails', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(historyResult('recent', 'h1'))
    const root = mount({ headOid: 'h1', compareBaseOid: 'b1' })
    await act(() => Promise.resolve())
    expect(historyProbe.current?.gitHistoryState.result?.items[0].subject).toBe('recent')
    const pending = Promise.withResolvers<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(pending.promise)
    await act(async () => root.rerender(<Probe headOid="h1" compareBaseOid="b2" />))
    expect(historyProbe.current?.gitHistoryState.result).toBeUndefined()
    await act(async () => pending.reject(new Error('offline')))
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'error', error: 'offline' })
  })
})
