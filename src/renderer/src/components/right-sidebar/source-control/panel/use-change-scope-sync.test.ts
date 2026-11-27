// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHistoryItem } from '../../../../../../shared/git/history/git-history-types'
import type { GitBranchChangeEntry } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitHistoryPanelState } from '../sync/use-git-history'
import type { SourceControlChangeScope } from './change-scope'
import { useChangeScopeSync } from './use-change-scope-sync'

const commit: GitHistoryItem = { id: 'c1', parentIds: [], subject: 'c1', message: 'c1' }
const changeScope: SourceControlChangeScope = {
  kind: 'commit',
  commit,
  pickedBaseOid: null,
  pickedFromBranchPage: true
}
const gitHistoryState: GitHistoryPanelState = { status: 'loading' }

afterEach(cleanup)

describe('useChangeScopeSync', () => {
  it('ignores a second Retry while the first retry is still loading', async () => {
    const entries: GitBranchChangeEntry[] = [{ path: 'a.ts', status: 'modified' }]
    let resolveRetry: (value: GitBranchChangeEntry[]) => void = () => {}
    const loadCommitFiles = vi
      .fn<(item: GitHistoryItem) => Promise<GitBranchChangeEntry[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRetry = resolve
          })
      )
      .mockRejectedValue(new Error('offline again'))
    const setCommitScopeFiles = vi.fn()
    const setChangeScope = vi.fn()
    const { result } = renderHook(() =>
      useChangeScopeSync({
        changeScope,
        setChangeScope,
        setCommitScopeFiles,
        gitHistoryState,
        statusHead: null,
        loadCommitFiles
      })
    )
    await act(() => Promise.resolve())
    expect(setCommitScopeFiles).toHaveBeenLastCalledWith({
      commitId: 'c1',
      status: 'error',
      error: 'offline'
    })

    const firstLoaded = vi.fn()
    act(() => result.current(firstLoaded))
    // The parent has not rendered the busy row yet, so the Retry button is still live.
    act(() => result.current(vi.fn()))
    await act(async () => resolveRetry(entries))

    expect(loadCommitFiles).toHaveBeenCalledTimes(2)
    expect(firstLoaded).toHaveBeenCalledTimes(1)
    expect(setCommitScopeFiles).toHaveBeenLastCalledWith({
      commitId: 'c1',
      status: 'ready',
      entries
    })
  })
})
