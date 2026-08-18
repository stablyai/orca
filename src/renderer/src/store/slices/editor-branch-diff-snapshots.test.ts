import { describe, expect, it, vi } from 'vitest'
import { createEditorStore } from './editor-slice-test-harness'
import type { AppState } from '../types'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

describe('createEditorSlice combined diff exclusions', () => {
  it('stores skipped unresolved conflicts on combined diff tabs', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'merge',
      entries: [
        {
          path: 'src/conflict.ts',
          status: 'modified',
          area: 'unstaged',
          conflictKind: 'both_modified',
          conflictStatus: 'unresolved'
        },
        {
          path: 'src/normal.ts',
          status: 'modified',
          area: 'unstaged'
        }
      ]
    })
    store.getState().openAllDiffs('wt-1', '/repo')

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        id: 'wt-1::all-diffs::uncommitted',
        skippedConflicts: [{ path: 'src/conflict.ts', conflictKind: 'both_modified' }]
      })
    )
  })

  it('uses a supplied combined diff entry snapshot instead of the whole area', () => {
    const store = createEditorStore()
    const normalEntry: GitStatusEntry = {
      path: 'src/normal.ts',
      status: 'modified',
      area: 'unstaged'
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'merge',
      entries: [
        {
          path: 'src/resolved.ts',
          status: 'modified',
          area: 'unstaged',
          conflictKind: 'both_modified',
          conflictStatus: 'resolved_locally'
        },
        normalEntry
      ]
    })
    store.getState().openAllDiffs('wt-1', '/repo', undefined, 'unstaged', [normalEntry])

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        id: 'wt-1::all-diffs::uncommitted::unstaged',
        uncommittedEntriesSnapshot: [normalEntry],
        skippedConflicts: []
      })
    )
  })

  it('includes untracked files in the all changes snapshot', () => {
    const store = createEditorStore()
    const stagedEntry: GitStatusEntry = {
      path: 'src/staged.ts',
      status: 'modified',
      area: 'staged'
    }
    const untrackedEntry: GitStatusEntry = {
      path: 'src/new.ts',
      status: 'untracked',
      area: 'untracked'
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [stagedEntry, untrackedEntry]
    })
    store.getState().openAllDiffs('wt-1', '/repo')

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        id: 'wt-1::all-diffs::uncommitted',
        uncommittedEntriesSnapshot: [stagedEntry, untrackedEntry]
      })
    )
  })

  it('opens all changes with uncommitted and committed branch snapshots', () => {
    const store = createEditorStore()
    const localEntry: GitStatusEntry = {
      path: 'src/local.ts',
      status: 'modified',
      area: 'unstaged'
    }
    const branchEntry: GitBranchChangeEntry = {
      path: 'src/committed.ts',
      status: 'modified'
    }
    const branchSummary: GitBranchCompareSummary = {
      baseRef: 'origin/main',
      baseOid: 'base-oid',
      compareRef: 'HEAD',
      headOid: 'head-oid',
      mergeBase: 'merge-base-oid',
      changedFiles: 1,
      status: 'ready'
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [localEntry]
    })
    store.setState({
      gitBranchCompareSummaryByWorktree: { 'wt-1': branchSummary },
      gitBranchChangesByWorktree: { 'wt-1': [branchEntry] }
    })
    store.getState().openAllDiffs('wt-1', '/repo')

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        id: 'wt-1::all-diffs::uncommitted',
        diffSource: 'combined-all',
        uncommittedEntriesSnapshot: [localEntry],
        branchEntriesSnapshot: [branchEntry],
        branchCompare: expect.objectContaining({
          baseRef: 'origin/main',
          baseOid: 'base-oid',
          headOid: 'head-oid',
          mergeBase: 'merge-base-oid'
        })
      })
    )
  })
})

describe('createEditorSlice openBranchDiff', () => {
  it('derives a runtime owner for branch diffs from the worktree host', () => {
    const store = createEditorStore()
    const worktreeId = 'repo-1::/srv/repo/worktree'
    const branchSummary: GitBranchCompareSummary = {
      baseRef: 'main',
      baseOid: 'base-oid',
      compareRef: 'HEAD',
      headOid: 'head-oid',
      mergeBase: 'merge-base-oid',
      changedFiles: 1,
      status: 'ready'
    }
    store.setState({
      repos: [{ id: 'repo-1', executionHostId: 'runtime:env-1' }] as unknown as AppState['repos'],
      worktreesByRepo: {
        'repo-1': [{ id: worktreeId, repoId: 'repo-1', hostId: 'runtime:env-1' }]
      } as unknown as AppState['worktreesByRepo']
    })

    store
      .getState()
      .openBranchDiff(
        worktreeId,
        '/srv/repo/worktree',
        { path: 'src/file.ts', status: 'modified' },
        branchSummary,
        'typescript'
      )

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        diffSource: 'branch',
        filePath: '/srv/repo/worktree/src/file.ts',
        runtimeEnvironmentId: 'env-1'
      })
    )
  })
})
