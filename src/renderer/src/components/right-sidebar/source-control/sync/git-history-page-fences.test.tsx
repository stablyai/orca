// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import type { GitHistoryResult } from '../../../../../../shared/git/history/git-history-types'
import { deferred, flush, unmountProbes } from '../panel/source-control-hook-test-harness'
import { Probe, mount, historyResult, mocks, historyProbe } from './git-history-hook-probe'

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
    expect(historyProbe.current?.gitHistoryState).toEqual({
      status: 'refreshing',
      result: historyResult('first', 'h1')
    })
  })

  it('shows a resolved no-base page, and loading only while HEAD is unknown', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValue(historyResult('recent', 'h1'))
    const root = await mount({ headOid: 'h1', compareBaseRef: null })
    await flush()
    expect(historyProbe.current?.gitHistoryState).toEqual({
      status: 'ready',
      result: historyResult('recent', 'h1')
    })

    await act(async () => {
      root.render(<Probe headUnknown compareBaseRef={null} />)
    })
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })
  })

  it('never shows a page for another HEAD, base OID or host', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(branchPage('first', 'h1', 'b1'))
    const root = await mount({ headOid: 'h1', compareBaseOid: 'b1' })
    await flush()
    expect(historyProbe.current?.gitHistoryState.result).toEqual(branchPage('first', 'h1', 'b1'))

    mocks.getRuntimeGitHistory.mockReturnValue(deferred<GitHistoryResult>().promise)
    await act(async () => {
      root.render(<Probe headOid="h2" compareBaseOid="b1" />)
    })
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })

    // Same base name and HEAD, but the base moved (fetch): the range changed.
    await act(async () => {
      root.render(<Probe headOid="h1" compareBaseOid="b2" />)
    })
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })

    await act(async () => {
      root.render(<Probe headOid="h1" compareBaseOid={null} />)
    })
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })

    await act(async () => {
      root.render(
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
    const root = await mount({ headOid: 'h1', compareBaseOid: 'b1' })
    await flush()
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'ready', result: emptyOnB1 })

    // Fetch moved origin/main (same name, same HEAD): the branch is now 1 ahead.
    const failed = deferred<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(failed.promise)
    await act(async () => {
      root.render(<Probe headOid="h1" compareBaseOid="b2" />)
    })
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'loading' })
    await act(async () => {
      failed.reject(new Error('offline'))
    })
    await flush()
    expect(historyProbe.current?.gitHistoryState).toEqual({ status: 'error', error: 'offline' })

    const late = deferred<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(late.promise)
    void historyProbe.current?.refreshGitHistory()
    await flush()
    expect(historyProbe.current?.gitHistoryState.result).toBeUndefined()
    await act(async () => {
      late.resolve(branchPage('ahead', 'h1', 'b2'))
    })
    await flush()
    expect(historyProbe.current?.gitHistoryState).toEqual({
      status: 'ready',
      result: branchPage('ahead', 'h1', 'b2')
    })
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

    expect(historyProbe.current?.gitHistoryState).toEqual({
      status: 'ready',
      result: historyResult('newer', 'h1')
    })
  })
})
