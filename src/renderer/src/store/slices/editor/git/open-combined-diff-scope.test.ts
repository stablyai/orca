import { describe, expect, it } from 'vitest'
import { createEditorTabsStore } from '../editor-slice-test-harness'
import type { GitBranchCompareSummary } from '../../../../../../shared/git/diff/git-diff-compare-types'

const READY: GitBranchCompareSummary = {
  baseRef: 'origin/main',
  baseOid: '1111111111111111111111111111111111111111',
  compareRef: 'feature',
  headOid: '2222222222222222222222222222222222222222',
  mergeBase: '3333333333333333333333333333333333333333',
  changedFiles: 1,
  status: 'ready'
}

function openWholeScope(summary: GitBranchCompareSummary | undefined) {
  const store = createEditorTabsStore()
  store.setState({
    gitStatusByWorktree: { 'wt-1': [{ path: 'a.ts', status: 'modified', area: 'unstaged' }] },
    gitBranchCompareSummaryByWorktree: summary ? { 'wt-1': summary } : {},
    gitBranchChangesByWorktree: { 'wt-1': [{ path: 'b.ts', status: 'modified' }] }
  })
  store.getState().openAllDiffs('wt-1', '/repo', undefined, undefined, undefined, {
    wholeScope: true
  })
  return store.getState().openFiles
}

describe('openAllDiffs whole scope', () => {
  it('opens uncommitted + branch as All Changes when branch compare is ready', () => {
    const [file] = openWholeScope(READY)
    expect(file).toMatchObject({
      id: 'wt-1::all-diffs::uncommitted',
      diffSource: 'combined-all',
      relativePath: 'All Changes'
    })
  })

  it('never titles a partial tab All Changes when branch compare failed or is missing', () => {
    for (const summary of [
      { ...READY, status: 'error' as const, mergeBase: null },
      { ...READY, status: 'invalid-base' as const },
      undefined
    ]) {
      const [file] = openWholeScope(summary)
      expect(file).toMatchObject({
        id: 'wt-1::all-diffs::uncommitted-only',
        diffSource: 'combined-uncommitted',
        relativePath: 'Uncommitted Changes'
      })
    }
  })

  it('keeps the Uncommitted scope in its own tab so it never reshapes All Changes', () => {
    const store = createEditorTabsStore()
    store.setState({
      gitStatusByWorktree: { 'wt-1': [] },
      gitBranchCompareSummaryByWorktree: { 'wt-1': READY },
      gitBranchChangesByWorktree: { 'wt-1': [] }
    })
    const open = store.getState().openAllDiffs
    open('wt-1', '/repo', undefined, undefined, undefined, { wholeScope: true })
    open('wt-1', '/repo', undefined, undefined, undefined, { uncommittedOnly: true })
    expect(store.getState().openFiles.map((file) => [file.id, file.diffSource])).toEqual([
      ['wt-1::all-diffs::uncommitted', 'combined-all'],
      ['wt-1::all-diffs::uncommitted-only', 'combined-uncommitted']
    ])
  })
})
