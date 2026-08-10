import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createEditorSlice } from './editor'
import type { AppState } from '../types'
import type { GitStatusResult } from '../../../../shared/types'

const MERGE_BASE = '1f3c0d9a5b6e7f8091a2b3c4d5e6f708192a3b4c'

function createEditorStore(): StoreApi<AppState> {
  // Only the editor slice + activeWorktreeId are needed for these tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    repos: [{ id: 'repo-1', path: '/repo' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo' }] },
    folderWorkspaces: [],
    projectGroups: [],
    recordFeatureInteraction: vi.fn(),
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

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
  it('stores a total published with the status result', () => {
    const store = createEditorStore()

    store
      .getState()
      .setGitStatus(
        'wt-1',
        status({ branchLineTotal: { added: 8259, removed: 670, mergeBase: MERGE_BASE } })
      )

    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toEqual({
      added: 8259,
      removed: 670,
      mergeBase: MERGE_BASE
    })
  })

  it('stores an exact zero total rather than treating it as absent', () => {
    const store = createEditorStore()

    store
      .getState()
      .setGitStatus(
        'wt-1',
        status({ branchLineTotal: { added: 0, removed: 0, mergeBase: MERGE_BASE } })
      )

    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toEqual({
      added: 0,
      removed: 0,
      mergeBase: MERGE_BASE
    })
  })

  it('keeps the published total when a later status omits the field', () => {
    const store = createEditorStore()
    store
      .getState()
      .setGitStatus(
        'wt-1',
        status({ branchLineTotal: { added: 24, removed: 3, mergeBase: MERGE_BASE } })
      )
    const published = store.getState().gitBranchLineTotalByWorktree['wt-1']

    // Why: an omitted field is "not computed on this pass" — a soft-deadline
    // miss or a cooldown — and the host keeps backfilling its cache. Clearing
    // it blanked the chip mid-poll and then flashed it back.
    store.getState().setGitStatus('wt-1', status())

    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toBe(published)
  })

  it('does not produce a new state object when a status merely omits the total', () => {
    const store = createEditorStore()
    const tick = status({ branchLineTotal: { added: 24, removed: 3, mergeBase: MERGE_BASE } })
    store.getState().setGitStatus('wt-1', tick)
    const before = store.getState()

    store.getState().setGitStatus('wt-1', { ...tick, branchLineTotal: undefined })

    expect(store.getState()).toBe(before)
  })

  it('clears a stored total when the listing hits the entry cap', () => {
    const store = createEditorStore()
    store
      .getState()
      .setGitStatus(
        'wt-1',
        status({ branchLineTotal: { added: 24, removed: 3, mergeBase: MERGE_BASE } })
      )

    store.getState().setGitStatus(
      'wt-1',
      status({
        entries: [{ path: 'generated/a.ts', status: 'untracked', area: 'untracked' }],
        didHitLimit: true,
        statusLength: 2
      })
    )

    expect(store.getState().gitStatusHugeByWorktree['wt-1']).toEqual({ limit: 1 })
    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toBeUndefined()
  })

  it('never substitutes zero or NaN for a total an old server never sent', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-1', status())

    const stored = store.getState().gitBranchLineTotalByWorktree['wt-1']
    expect(stored).toBeUndefined()
    expect(stored ?? null).toBeNull()
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

  it('replaces the total when the fork point moves', () => {
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
        'wt-1',
        status({ branchLineTotal: { added: 24, removed: 3, mergeBase: 'rebased' } })
      )

    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toEqual({
      added: 24,
      removed: 3,
      mergeBase: 'rebased'
    })
  })

  it('does not produce a new state object for an unchanged status tick', () => {
    const store = createEditorStore()
    const tick = status({ branchLineTotal: { added: 24, removed: 3, mergeBase: MERGE_BASE } })
    store.getState().setGitStatus('wt-1', tick)
    const before = store.getState()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.getState().setGitStatus('wt-1', {
      ...tick,
      entries: [...tick.entries],
      branchLineTotal: { added: 24, removed: 3, mergeBase: MERGE_BASE }
    })
    unsubscribe()

    expect(store.getState()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('produces a new state object when only the total changed', () => {
    const store = createEditorStore()
    const tick = status({ branchLineTotal: { added: 24, removed: 3, mergeBase: MERGE_BASE } })
    store.getState().setGitStatus('wt-1', tick)
    const before = store.getState()

    store.getState().setGitStatus('wt-1', {
      ...tick,
      branchLineTotal: { added: 25, removed: 3, mergeBase: MERGE_BASE }
    })

    expect(store.getState()).not.toBe(before)
    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']).toEqual({
      added: 25,
      removed: 3,
      mergeBase: MERGE_BASE
    })
  })

  // Moving a line from a source file into a test file leaves the totals
  // identical; without the split in the equality check the hover would keep
  // showing the old share.
  it('produces a new state object when only the test split changed', () => {
    const store = createEditorStore()
    const tick = status({
      branchLineTotal: {
        added: 24,
        removed: 3,
        mergeBase: MERGE_BASE,
        test: { added: 4, removed: 0 }
      }
    })
    store.getState().setGitStatus('wt-1', tick)
    const before = store.getState()

    store.getState().setGitStatus('wt-1', {
      ...tick,
      branchLineTotal: {
        added: 24,
        removed: 3,
        mergeBase: MERGE_BASE,
        test: { added: 5, removed: 1 }
      }
    })

    expect(store.getState()).not.toBe(before)
    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']?.test).toEqual({
      added: 5,
      removed: 1
    })
  })

  it('produces a new state object when only the generated split changed', () => {
    const store = createEditorStore()
    const tick = status({
      branchLineTotal: {
        added: 24,
        removed: 3,
        mergeBase: MERGE_BASE,
        generated: { added: 8, removed: 0 }
      }
    })
    store.getState().setGitStatus('wt-1', tick)
    const before = store.getState()

    store.getState().setGitStatus('wt-1', {
      ...tick,
      branchLineTotal: {
        added: 24,
        removed: 3,
        mergeBase: MERGE_BASE,
        generated: { added: 12, removed: 1 }
      }
    })

    expect(store.getState()).not.toBe(before)
    expect(store.getState().gitBranchLineTotalByWorktree['wt-1']?.generated).toEqual({
      added: 12,
      removed: 1
    })
  })

  it('leaves other worktree entries referentially stable when one total changes', () => {
    const store = createEditorStore()
    store
      .getState()
      .setGitStatus(
        'wt-2',
        status({ branchLineTotal: { added: 1, removed: 1, mergeBase: 'other' } })
      )
    const otherTotal = store.getState().gitBranchLineTotalByWorktree['wt-2']

    store
      .getState()
      .setGitStatus(
        'wt-1',
        status({ branchLineTotal: { added: 24, removed: 3, mergeBase: MERGE_BASE } })
      )

    expect(store.getState().gitBranchLineTotalByWorktree['wt-2']).toBe(otherTotal)
  })
})
