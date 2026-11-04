import { describe, expect, it } from 'vitest'
import { createEditorStore } from './editor-slice-test-harness'
import type { GitStatusResult } from '../../../../shared/git/status/git-status-types'

const MERGE_BASE = '1f3c0d9a5b6e7f8091a2b3c4d5e6f708192a3b4c'

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    conflictOperation: 'unknown',
    entries: [{ path: 'src/index.ts', status: 'modified', area: 'unstaged' }],
    head: 'head-1',
    ignoredPaths: [],
    ...overrides
  }
}

describe('createEditorSlice branch line total', () => {
  it('keeps the published total when a later status omits the field', () => {
    const store = createEditorStore()
    store
      .getState()
      .setGitStatus(
        'wt-1',
        status({ branchLineTotal: { added: 24, removed: 3, mergeBase: MERGE_BASE } })
      )
    const published = store.getState().gitBranchLineTotalByWorktree['wt-1']

    // Omitted totals mean deferred computation; retain host backfill cache or polling flashes the chip blank.
    store.getState().setGitStatus('wt-1', status())

    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toBe(published)
  })

  it('clears an unavailable total and restores it only after a new exact result', () => {
    const store = createEditorStore()
    const total = { added: 0, removed: 3, mergeBase: MERGE_BASE }
    store.getState().setGitStatus('wt-1', status({ branchLineTotal: total }))

    store.getState().setGitStatus('wt-1', status({ branchLineTotalUnavailable: MERGE_BASE }))

    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toBeUndefined()
    store.getState().setGitStatus('wt-1', status())
    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toBeUndefined()

    const recovered = { added: 1, removed: 3, mergeBase: MERGE_BASE }
    store.getState().setGitStatus('wt-1', status({ branchLineTotal: recovered }))
    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toEqual(recovered)
  })

  it('does not clear a newer total when an older fork point becomes unavailable', () => {
    const store = createEditorStore()
    const total = { added: 2, removed: 1, mergeBase: 'rebased' }
    store.getState().setGitStatus('wt-1', status({ branchLineTotal: total }))

    store.getState().setGitStatus('wt-1', status({ branchLineTotalUnavailable: MERGE_BASE }))

    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toEqual(total)
  })

  it('keeps totals independent per worktree', () => {
    const store = createEditorStore()
    store
      .getState()
      .setGitStatus(
        'wt-1',
        status({ branchLineTotal: { added: 24, removed: 3, mergeBase: MERGE_BASE } })
      )
    store
      .getState()
      .setGitStatus(
        'wt-2',
        status({ branchLineTotal: { added: 1, removed: 1, mergeBase: 'other' } })
      )

    store.getState().setGitStatus('wt-1', status({ didHitLimit: true, statusLength: 2 }))

    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toBeUndefined()
    expect(store.getState().gitBranchLineTotalByWorktree['wt-2']).toEqual({
      added: 1,
      removed: 1,
      mergeBase: 'other'
    })
  })
})
