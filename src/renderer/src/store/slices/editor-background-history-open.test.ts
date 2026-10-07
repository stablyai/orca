import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import { createEditorStore } from './editor-slice-test-harness'
import type { AppState } from '../types'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitCommitCompareSummary
} from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: vi.fn()
}))

// why: a lineage section opens diffs for a worktree that is not on screen (wt-1 stays active)
const BACKGROUND = 'wt-2'
const branchEntry: GitBranchChangeEntry = { path: 'src/file.ts', status: 'modified' }
const branchSummary: GitBranchCompareSummary = {
  baseRef: 'main',
  baseOid: 'base-oid',
  compareRef: 'HEAD',
  headOid: 'head-oid',
  mergeBase: 'merge-base-oid',
  changedFiles: 1,
  status: 'ready'
}
const commitSummary: GitCommitCompareSummary = {
  commitOid: 'commit-oid',
  parentOid: 'parent-oid',
  compareRef: 'commit-oid',
  baseRef: 'parent-oid',
  changedFiles: 1,
  status: 'ready'
}
const conflictEntry: GitStatusEntry = {
  path: 'src/conflict.ts',
  status: 'modified',
  area: 'unstaged',
  conflictKind: 'both_modified',
  conflictStatus: 'unresolved',
  conflictStatusSource: 'git'
}

let store: StoreApi<AppState>

function onScreenEditor(): Pick<AppState, 'activeFileId' | 'activeTabType'> {
  const { activeFileId, activeTabType } = store.getState()
  return { activeFileId, activeTabType }
}

beforeEach(() => {
  store = createEditorStore()
  store.getState().openFile({
    filePath: '/repo/on-screen.ts',
    relativePath: 'on-screen.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
})

describe('background history, conflict and combined diff opens', () => {
  const opens: [string, () => void][] = [
    [
      'openBranchDiff',
      () =>
        store
          .getState()
          .openBranchDiff(BACKGROUND, '/repo-2', branchEntry, branchSummary, 'typescript')
    ],
    [
      'openCommitDiff',
      () =>
        store
          .getState()
          .openCommitDiff(BACKGROUND, '/repo-2', branchEntry, commitSummary, 'typescript')
    ],
    [
      'openConflictFile',
      () => store.getState().openConflictFile(BACKGROUND, '/repo-2', conflictEntry, 'typescript')
    ],
    [
      'openBranchAllDiffs',
      () => store.getState().openBranchAllDiffs(BACKGROUND, '/repo-2', branchSummary)
    ],
    [
      'openCommitAllDiffs',
      () =>
        store
          .getState()
          .openCommitAllDiffs(BACKGROUND, '/repo-2', commitSummary, [branchEntry], 'subject')
    ],
    ['openAllDiffs', () => store.getState().openAllDiffs(BACKGROUND, '/repo-2')],
    [
      'openConflictReview',
      () =>
        store
          .getState()
          .openConflictReview(
            BACKGROUND,
            '/repo-2',
            [{ path: conflictEntry.path, conflictKind: 'both_modified' }],
            'live-summary'
          )
    ]
  ]

  it.each(opens)('%s leaves the on-screen editor alone', (_name, open) => {
    const before = onScreenEditor()
    expect(before.activeFileId).toBeTruthy()

    open()

    expect(onScreenEditor()).toEqual(before)
    const backgroundFileId = store.getState().activeFileIdByWorktree[BACKGROUND]
    expect(backgroundFileId).toBeTruthy()
    expect(store.getState().activeTabTypeByWorktree[BACKGROUND]).toBe('editor')
    expect(store.getState().openFiles.some((file) => file.id === backgroundFileId)).toBe(true)
  })

  it('still focuses a branch diff opened for the on-screen worktree', () => {
    store.getState().openBranchDiff('wt-1', '/repo', branchEntry, branchSummary, 'typescript')
    expect(store.getState().activeFileId).toBe(store.getState().activeFileIdByWorktree['wt-1'])
    expect(store.getState().activeFileId).toContain('::diff::branch::')
  })
})
