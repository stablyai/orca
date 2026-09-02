import { describe, expect, it, vi } from 'vitest'
import { createEditorStore } from './editor-slice-test-harness'

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

describe('createEditorSlice conflict status reconciliation', () => {
  it('records clean git status checks with an explicit empty entry list', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-clean', {
      conflictOperation: 'unknown',
      entries: []
    })

    expect(store.getState().gitStatusByWorktree).toHaveProperty('wt-clean')
    expect(store.getState().gitStatusByWorktree['wt-clean']).toEqual([])
  })

  it('keeps the capped state sticky until a complete result recovers', () => {
    const store = createEditorStore()
    store.getState().setGitStatus('wt-huge', {
      conflictOperation: 'unknown',
      entries: [{ path: 'generated/a.ts', status: 'untracked', area: 'untracked' }],
      didHitLimit: true,
      statusLength: 2
    })

    expect(store.getState().gitStatusHugeByWorktree['wt-huge']).toEqual({ limit: 1 })

    store.getState().setGitStatus('wt-huge', {
      conflictOperation: 'unknown',
      entries: [{ path: 'src/index.ts', status: 'modified', area: 'unstaged' }]
    })

    expect(store.getState().gitStatusHugeByWorktree['wt-huge']).toBeUndefined()
  })

  it('preserves omitted conflict state when a capped result is incomplete', () => {
    const store = createEditorStore()
    const conflict = {
      path: 'src/conflict.ts',
      status: 'modified' as const,
      area: 'unstaged' as const,
      conflictKind: 'both_modified' as const,
      conflictStatus: 'unresolved' as const,
      conflictStatusSource: 'git' as const
    }
    store.getState().trackConflictPath('wt-huge', conflict.path, conflict.conflictKind)
    store.getState().openConflictFile('wt-huge', '/repo', conflict, 'typescript')
    store.getState().setGitStatus('wt-huge', {
      conflictOperation: 'merge',
      entries: [conflict]
    })

    store.getState().setGitStatus('wt-huge', {
      conflictOperation: 'unknown',
      entries: [{ path: 'generated/a.ts', status: 'untracked', area: 'untracked' }],
      didHitLimit: true,
      statusLength: 2
    })

    expect(store.getState().trackedConflictPathsByWorktree['wt-huge']).toEqual({
      'src/conflict.ts': 'both_modified'
    })
    expect(store.getState().gitConflictOperationByWorktree['wt-huge']).toBe('merge')
    expect(
      store.getState().openFiles.find((file) => file.relativePath === 'src/conflict.ts')?.conflict
    ).toMatchObject({
      conflictKind: 'both_modified',
      conflictStatus: 'unresolved'
    })

    store.getState().setGitStatus('wt-huge', {
      conflictOperation: 'unknown',
      entries: []
    })

    expect(store.getState().trackedConflictPathsByWorktree['wt-huge']).toEqual({})
    expect(store.getState().gitConflictOperationByWorktree['wt-huge']).toBe('unknown')
  })

  it('treats a blank git status HEAD as unknown without invalidating branch compare', () => {
    const store = createEditorStore()
    const summary = {
      baseRef: 'refs/remotes/origin/main',
      baseOid: 'base-old',
      compareRef: 'feature',
      headOid: 'head-old',
      mergeBase: 'base-old',
      changedFiles: 0,
      commitsAhead: 0,
      status: 'ready' as const
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: summary.headOid,
      branch: 'refs/heads/feature'
    })
    store.getState().beginGitBranchCompareRequest('wt-1', 'req-clean', summary.baseRef)
    store.getState().setGitBranchCompareResult('wt-1', 'req-clean', {
      summary,
      entries: []
    })

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: '',
      branch: 'refs/heads/feature'
    })

    expect(store.getState().gitStatusHeadByWorktree['wt-1']).toBeUndefined()
    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(summary)
  })

  it('rejects a stale clean branch compare after git status reports a newer HEAD', () => {
    const store = createEditorStore()
    const cleanSummary = {
      baseRef: 'refs/remotes/origin/main',
      baseOid: 'base-old',
      compareRef: 'feature',
      headOid: 'head-old',
      mergeBase: 'base-old',
      changedFiles: 0,
      commitsAhead: 0,
      status: 'ready' as const
    }
    const updatedSummary = {
      ...cleanSummary,
      headOid: 'head-new',
      mergeBase: 'merge-new',
      changedFiles: 1,
      commitsAhead: 1
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: cleanSummary.headOid,
      branch: 'refs/heads/feature'
    })
    store.getState().beginGitBranchCompareRequest('wt-1', 'req-clean', cleanSummary.baseRef)
    store.getState().setGitBranchCompareResult('wt-1', 'req-clean', {
      summary: cleanSummary,
      entries: []
    })
    store
      .getState()
      .beginGitBranchCompareRequest(
        'wt-1',
        'req-refresh-before-head-change',
        cleanSummary.baseRef,
        { preserveExistingSummary: true }
      )

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: updatedSummary.headOid,
      branch: 'refs/heads/feature'
    })
    store.getState().setGitBranchCompareResult('wt-1', 'req-refresh-before-head-change', {
      summary: cleanSummary,
      entries: []
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual({
      baseRef: cleanSummary.baseRef,
      baseOid: null,
      compareRef: 'HEAD',
      headOid: null,
      mergeBase: null,
      changedFiles: 0,
      status: 'loading'
    })
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual([])
    expect(store.getState().gitBranchCompareRequestKeyByWorktree['wt-1']).toBe(
      'req-refresh-before-head-change'
    )

    store.getState().setGitBranchCompareResult('wt-1', 'req-refresh-before-head-change', {
      summary: updatedSummary,
      entries: [{ path: 'src/new.ts', status: 'modified' }]
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(updatedSummary)
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual([
      { path: 'src/new.ts', status: 'modified' }
    ])
  })

  it('rejects a stale unborn branch compare after git status reports a committed HEAD', () => {
    const store = createEditorStore()
    const unbornSummary = {
      baseRef: 'refs/remotes/origin/main',
      baseOid: 'base-old',
      compareRef: 'feature',
      headOid: null,
      mergeBase: null,
      changedFiles: 0,
      commitsAhead: 0,
      status: 'ready' as const
    }
    const committedSummary = {
      ...unbornSummary,
      headOid: 'head-new',
      mergeBase: 'base-old',
      changedFiles: 1,
      commitsAhead: 1
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: '(initial)',
      branch: 'refs/heads/feature'
    })
    store.getState().beginGitBranchCompareRequest('wt-1', 'req-unborn', unbornSummary.baseRef)
    store.getState().setGitBranchCompareResult('wt-1', 'req-unborn', {
      summary: unbornSummary,
      entries: []
    })
    store
      .getState()
      .beginGitBranchCompareRequest('wt-1', 'req-before-first-commit', unbornSummary.baseRef, {
        preserveExistingSummary: true
      })

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: committedSummary.headOid,
      branch: 'refs/heads/feature'
    })
    store.getState().setGitBranchCompareResult('wt-1', 'req-before-first-commit', {
      summary: unbornSummary,
      entries: []
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual({
      baseRef: unbornSummary.baseRef,
      baseOid: null,
      compareRef: 'HEAD',
      headOid: null,
      mergeBase: null,
      changedFiles: 0,
      status: 'loading'
    })

    store.getState().setGitBranchCompareResult('wt-1', 'req-before-first-commit', {
      summary: committedSummary,
      entries: [{ path: 'src/first.ts', status: 'added' }]
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(committedSummary)
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual([
      { path: 'src/first.ts', status: 'added' }
    ])
  })

  it('accepts an unborn branch compare when git status reports the initial branch marker', () => {
    const store = createEditorStore()
    const unbornSummary = {
      baseRef: 'refs/remotes/origin/main',
      baseOid: 'base-old',
      compareRef: 'feature',
      headOid: null,
      mergeBase: null,
      changedFiles: 0,
      commitsAhead: 0,
      status: 'ready' as const
    }

    store.getState().beginGitBranchCompareRequest('wt-1', 'req-unborn', unbornSummary.baseRef)
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: '(initial)',
      branch: 'refs/heads/feature'
    })
    store.getState().setGitBranchCompareResult('wt-1', 'req-unborn', {
      summary: unbornSummary,
      entries: []
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(unbornSummary)
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual([])
  })

  it('keeps loading branch compare state when an older HEAD result arrives', () => {
    const store = createEditorStore()

    store.getState().beginGitBranchCompareRequest('wt-1', 'req-stale', 'refs/remotes/origin/main')
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: 'head-new',
      branch: 'refs/heads/feature'
    })
    store.getState().setGitBranchCompareResult('wt-1', 'req-stale', {
      summary: {
        baseRef: 'refs/remotes/origin/main',
        baseOid: 'base-old',
        compareRef: 'feature',
        headOid: 'head-old',
        mergeBase: 'base-old',
        changedFiles: 0,
        commitsAhead: 0,
        status: 'ready'
      },
      entries: []
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual({
      baseRef: 'refs/remotes/origin/main',
      baseOid: null,
      compareRef: 'HEAD',
      headOid: null,
      mergeBase: null,
      changedFiles: 0,
      status: 'loading'
    })
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toBeUndefined()
  })

  it('accepts a newer branch compare before git status catches up', () => {
    const store = createEditorStore()
    const summary = {
      baseRef: 'refs/remotes/origin/main',
      baseOid: 'base-old',
      compareRef: 'feature',
      headOid: 'head-new',
      mergeBase: 'base-old',
      changedFiles: 1,
      commitsAhead: 1,
      status: 'ready' as const
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: 'head-old',
      branch: 'refs/heads/feature'
    })
    store.getState().beginGitBranchCompareRequest('wt-1', 'req-newer', summary.baseRef)
    store.getState().setGitBranchCompareResult('wt-1', 'req-newer', {
      summary,
      entries: [{ path: 'src/new.ts', status: 'modified' }]
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(summary)
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual([
      { path: 'src/new.ts', status: 'modified' }
    ])
  })

  it('preserves a newer branch compare when an unchanged older status refresh returns', () => {
    const store = createEditorStore()
    const summary = {
      baseRef: 'refs/remotes/origin/main',
      baseOid: 'base-old',
      compareRef: 'feature',
      headOid: 'head-new',
      mergeBase: 'base-old',
      changedFiles: 1,
      commitsAhead: 1,
      status: 'ready' as const
    }

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: 'head-old',
      branch: 'refs/heads/feature'
    })
    store.getState().beginGitBranchCompareRequest('wt-1', 'req-newer', summary.baseRef)
    store.getState().setGitBranchCompareResult('wt-1', 'req-newer', {
      summary,
      entries: [{ path: 'src/new.ts', status: 'modified' }]
    })
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      head: 'head-old',
      branch: 'refs/heads/feature'
    })

    expect(store.getState().gitBranchCompareSummaryByWorktree['wt-1']).toEqual(summary)
    expect(store.getState().gitBranchChangesByWorktree['wt-1']).toEqual([
      { path: 'src/new.ts', status: 'modified' }
    ])
  })

  it('clears ignored path cache when status refresh omits ignored paths', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      ignoredPaths: ['dist/', '.env']
    })
    expect(store.getState().gitIgnoredPathsByWorktree['wt-1']).toEqual(['dist/', '.env'])

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: []
    })

    expect(store.getState().gitIgnoredPathsByWorktree['wt-1']).toEqual([])
  })

  it('tracks unresolved conflicts when opened through the conflict-safe entry point', () => {
    const store = createEditorStore()

    store.getState().openConflictFile(
      'wt-1',
      '/repo',
      {
        path: 'src/conflict.ts',
        status: 'modified',
        area: 'unstaged',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved',
        conflictStatusSource: 'git'
      },
      'typescript'
    )
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'merge',
      entries: [{ path: 'src/conflict.ts', status: 'modified', area: 'staged' }]
    })

    expect(store.getState().trackedConflictPathsByWorktree['wt-1']).toEqual({
      'src/conflict.ts': 'both_modified'
    })
    expect(store.getState().gitStatusByWorktree['wt-1']).toEqual([
      {
        path: 'src/conflict.ts',
        status: 'modified',
        area: 'staged',
        conflictKind: 'both_modified',
        conflictStatus: 'resolved_locally',
        conflictStatusSource: 'session'
      }
    ])
  })

  it('keeps the conflict review active when selecting a conflict from its tree', () => {
    const store = createEditorStore()

    store
      .getState()
      .openConflictReview(
        'wt-1',
        '/repo',
        [{ path: 'src/conflict.ts', conflictKind: 'both_modified' }],
        'live-summary'
      )
    store.getState().openConflictReviewFile(
      'wt-1::conflict-review',
      'wt-1',
      '/repo',
      {
        path: 'src/conflict.ts',
        status: 'modified',
        area: 'unstaged',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved',
        conflictStatusSource: 'git'
      },
      'typescript'
    )

    const reviewFile = store
      .getState()
      .openFiles.find((file) => file.id === 'wt-1::conflict-review')

    expect(store.getState().activeFileId).toBe('wt-1::conflict-review')
    expect(reviewFile?.conflictReview?.selectedFileId).toBe('/repo/src/conflict.ts')
    expect(store.getState().openFiles).toContainEqual(
      expect.objectContaining({
        id: '/repo/src/conflict.ts',
        mode: 'edit',
        conflict: expect.objectContaining({ conflictStatus: 'unresolved' })
      })
    )
  })

  it('marks tracked conflicts as resolved locally after live conflict state disappears', () => {
    const store = createEditorStore()

    store.getState().trackConflictPath('wt-1', 'src/conflict.ts', 'both_modified')
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'merge',
      entries: [
        {
          path: 'src/conflict.ts',
          status: 'modified',
          area: 'unstaged',
          conflictKind: 'both_modified',
          conflictStatus: 'unresolved'
        }
      ]
    })
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'merge',
      entries: [{ path: 'src/conflict.ts', status: 'modified', area: 'staged' }]
    })

    expect(store.getState().gitStatusByWorktree['wt-1']).toEqual([
      {
        path: 'src/conflict.ts',
        status: 'modified',
        area: 'staged',
        conflictKind: 'both_modified',
        conflictStatus: 'resolved_locally',
        conflictStatusSource: 'session'
      }
    ])
  })

  it('clears tracked conflict continuity on abort-like transitions', () => {
    const store = createEditorStore()

    store.getState().trackConflictPath('wt-1', 'src/conflict.ts', 'both_modified')
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'merge',
      entries: [
        {
          path: 'src/conflict.ts',
          status: 'modified',
          area: 'unstaged',
          conflictKind: 'both_modified',
          conflictStatus: 'unresolved'
        }
      ]
    })
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [{ path: 'src/conflict.ts', status: 'modified', area: 'unstaged' }]
    })

    expect(store.getState().gitStatusByWorktree['wt-1']).toEqual([
      { path: 'src/conflict.ts', status: 'modified', area: 'unstaged' }
    ])
    expect(store.getState().trackedConflictPathsByWorktree['wt-1']).toEqual({})
  })
})
