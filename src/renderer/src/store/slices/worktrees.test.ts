/* eslint-disable max-lines --
 * Why: this slice test keeps the worktree store scenarios in one file so the
 * shared mock store setup stays consistent across closely related behaviors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { Worktree } from '../../../../shared/types'

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta: vi.fn().mockResolvedValue(undefined)
  },
  pty: {
    kill: vi.fn().mockResolvedValue(undefined)
  }
}

// @ts-expect-error -- test shim
globalThis.window = { api: mockApi }

import { createWorktreeSlice } from './worktrees'

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        // Why: this test isolates the worktree slice, so it only provides the
        // state surface that `createWorktreeSlice` reads and writes.
        ...createWorktreeSlice(...a),
        shutdownWorktreeTerminals: vi.fn().mockResolvedValue(undefined),
        tabsByWorktree: {},
        tabBarOrderByWorktree: {},
        pendingReconnectTabByWorktree: {},
        activeTabIdByWorktree: {},
        unifiedTabsByWorktree: {},
        groupsByWorktree: {},
        activeGroupIdByWorktree: {},
        layoutByWorktree: {},
        openFiles: [],
        editorDrafts: {},
        markdownViewMode: {},
        expandedDirs: {},
        gitStatusByWorktree: {},
        gitConflictOperationByWorktree: {},
        trackedConflictPathsByWorktree: {},
        gitBranchChangesByWorktree: {},
        gitBranchCompareSummaryByWorktree: {},
        gitBranchCompareRequestKeyByWorktree: {},
        activeFileIdByWorktree: {},
        activeBrowserTabIdByWorktree: {},
        browserTabsByWorktree: {},
        activeTabTypeByWorktree: {},
        activeWorktreeId: null,
        activeTabId: null,
        activeFileId: null,
        activeBrowserTabId: null,
        activeTabType: 'terminal' as const
      }) as unknown as AppState
  )
}

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: '/tmp/wt',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('fetchWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not notify subscribers when the fetched payload is unchanged', async () => {
    const store = createTestStore()
    const existing = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const subscriber = vi.fn()

    mockApi.worktrees.list.mockResolvedValue([existing])
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    const unsubscribe = store.subscribe(subscriber)
    await store.getState().fetchWorktrees('repo1')
    unsubscribe()

    expect(store.getState().worktreesByRepo.repo1).toEqual([existing])
    expect(store.getState().sortEpoch).toBe(7)
    expect(subscriber).not.toHaveBeenCalled()
  })

  it('updates the repo entry and bumps sortEpoch when git reports a branch change', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature-one',
      displayName: 'feature-one'
    })
    const refreshed = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature-two',
      head: 'def456',
      displayName: 'feature-two'
    })

    mockApi.worktrees.list.mockResolvedValue([refreshed])
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('keeps the last known worktree list when a refresh transiently returns empty', async () => {
    const store = createTestStore()
    const existing = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    mockApi.worktrees.list.mockResolvedValue([])
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([existing])
    expect(store.getState().sortEpoch).toBe(7)
  })

  it('accepts an empty refresh when the repo had no cached worktrees', async () => {
    const store = createTestStore()

    mockApi.worktrees.list.mockResolvedValue([])
    store.setState({ worktreesByRepo: {}, sortEpoch: 7 } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([])
    expect(store.getState().sortEpoch).toBe(8)
  })
})

describe('removeWorktree state cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('cleans up editorDrafts for files in the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repo1::/path/wt1',
          filePath: '/path/wt1/file.ts',
          relativePath: 'file.ts',
          language: 'typescript',
          isDirty: true,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      editorDrafts: {
        'file-1': 'draft content for wt1',
        'file-2': 'draft content for another worktree'
      }
    } as unknown as Partial<AppState>)

    const result = await store.getState().removeWorktree('repo1::/path/wt1')

    expect(result).toEqual({ ok: true })
    // Draft for file-1 should be removed, draft for file-2 should remain
    expect(store.getState().editorDrafts).toEqual({
      'file-2': 'draft content for another worktree'
    })
  })

  it('cleans up markdownViewMode for files in the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repo1::/path/wt1',
          filePath: '/path/wt1/readme.md',
          relativePath: 'readme.md',
          language: 'markdown',
          isDirty: false,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      markdownViewMode: {
        'file-1': 'rich' as const,
        'file-2': 'source' as const
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().markdownViewMode).toEqual({ 'file-2': 'source' })
  })

  it('cleans up expandedDirs for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      expandedDirs: {
        'repo1::/path/wt1': new Set(['src', 'src/lib']),
        'repo1::/path/wt2': new Set(['test'])
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().expandedDirs).toEqual({
      'repo1::/path/wt2': new Set(['test'])
    })
  })

  it('cleans up activeTabIdByWorktree for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeTabIdByWorktree: {
        'repo1::/path/wt1': 'tab-1',
        'repo1::/path/wt2': 'tab-2'
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().activeTabIdByWorktree).toEqual({
      'repo1::/path/wt2': 'tab-2'
    })
  })

  it('cleans up tabBarOrderByWorktree for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      tabBarOrderByWorktree: {
        'repo1::/path/wt1': ['tab-1', 'file-1', 'browser-1'],
        'repo1::/path/wt2': ['tab-2']
      }
    } as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().tabBarOrderByWorktree).toEqual({
      'repo1::/path/wt2': ['tab-2']
    })
  })

  it('cleans up split-tab model state for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      pendingReconnectTabByWorktree: {
        'repo1::/path/wt1': ['tab-1'],
        'repo1::/path/wt2': ['tab-2']
      },
      unifiedTabsByWorktree: {
        'repo1::/path/wt1': [{ id: 'tab-1', worktreeId: 'repo1::/path/wt1' }],
        'repo1::/path/wt2': [{ id: 'tab-2', worktreeId: 'repo1::/path/wt2' }]
      },
      groupsByWorktree: {
        'repo1::/path/wt1': [
          { id: 'group-1', worktreeId: 'repo1::/path/wt1', activeTabId: 'tab-1' }
        ],
        'repo1::/path/wt2': [
          { id: 'group-2', worktreeId: 'repo1::/path/wt2', activeTabId: 'tab-2' }
        ]
      },
      activeGroupIdByWorktree: {
        'repo1::/path/wt1': 'group-1',
        'repo1::/path/wt2': 'group-2'
      },
      layoutByWorktree: {
        'repo1::/path/wt1': { type: 'leaf', groupId: 'group-1' },
        'repo1::/path/wt2': { type: 'leaf', groupId: 'group-2' }
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().pendingReconnectTabByWorktree).toEqual({
      'repo1::/path/wt2': ['tab-2']
    })
    expect(store.getState().unifiedTabsByWorktree).toEqual({
      'repo1::/path/wt2': [{ id: 'tab-2', worktreeId: 'repo1::/path/wt2' }]
    })
    expect(store.getState().groupsByWorktree).toEqual({
      'repo1::/path/wt2': [{ id: 'group-2', worktreeId: 'repo1::/path/wt2', activeTabId: 'tab-2' }]
    })
    expect(store.getState().activeGroupIdByWorktree).toEqual({
      'repo1::/path/wt2': 'group-2'
    })
    expect(store.getState().layoutByWorktree).toEqual({
      'repo1::/path/wt2': { type: 'leaf', groupId: 'group-2' }
    })
  })

  it('cleans up git caches for the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      gitStatusByWorktree: {
        'repo1::/path/wt1': [{ path: 'a.ts' }],
        'repo1::/path/wt2': [{ path: 'b.ts' }]
      },
      gitConflictOperationByWorktree: {
        'repo1::/path/wt1': 'merge',
        'repo1::/path/wt2': 'unknown'
      },
      trackedConflictPathsByWorktree: {
        'repo1::/path/wt1': { 'a.ts': 'both_modified' },
        'repo1::/path/wt2': { 'b.ts': 'both_modified' }
      },
      gitBranchChangesByWorktree: {
        'repo1::/path/wt1': [{ path: 'a.ts' }],
        'repo1::/path/wt2': [{ path: 'b.ts' }]
      },
      gitBranchCompareSummaryByWorktree: {
        'repo1::/path/wt1': { status: 'ready' },
        'repo1::/path/wt2': { status: 'loading' }
      },
      gitBranchCompareRequestKeyByWorktree: {
        'repo1::/path/wt1': 'req-1',
        'repo1::/path/wt2': 'req-2'
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().gitStatusByWorktree).toEqual({
      'repo1::/path/wt2': [{ path: 'b.ts' }]
    })
    expect(store.getState().gitConflictOperationByWorktree).toEqual({
      'repo1::/path/wt2': 'unknown'
    })
    expect(store.getState().trackedConflictPathsByWorktree).toEqual({
      'repo1::/path/wt2': { 'b.ts': 'both_modified' }
    })
    expect(store.getState().gitBranchChangesByWorktree).toEqual({
      'repo1::/path/wt2': [{ path: 'b.ts' }]
    })
    expect(store.getState().gitBranchCompareSummaryByWorktree).toEqual({
      'repo1::/path/wt2': { status: 'loading' }
    })
    expect(store.getState().gitBranchCompareRequestKeyByWorktree).toEqual({
      'repo1::/path/wt2': 'req-2'
    })
  })

  it('skips editorDrafts shallow copy when no files belong to the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    const drafts = { 'file-2': 'some content' }
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [],
      editorDrafts: drafts
    } as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    // The same reference should be returned (no unnecessary shallow copy)
    expect(store.getState().editorDrafts).toBe(drafts)
  })
})

// Why: ghostty "show until interact" model — BEL must raise the sidebar dot
// even on the active worktree, and only clearWorktreeUnread (called from the
// terminal pane on keystroke / pointerdown) dismisses it. Pins both halves
// of that contract.
describe('worktree unread (show-until-interact)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('markWorktreeUnread sets isUnread even when the worktree is active', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: wt.id
    } as Partial<AppState>)

    store.getState().markWorktreeUnread(wt.id)

    const after = store.getState().worktreesByRepo.repo1[0]
    expect(after.isUnread).toBe(true)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: wt.id,
        updates: expect.objectContaining({ isUnread: true })
      })
    )
  })

  it('clearWorktreeUnread clears isUnread and persists the change', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      isUnread: true
    })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: wt.id
    } as Partial<AppState>)

    store.getState().clearWorktreeUnread(wt.id)

    const after = store.getState().worktreesByRepo.repo1[0]
    expect(after.isUnread).toBe(false)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: wt.id,
        updates: { isUnread: false }
      })
    )
  })

  it('clearWorktreeUnread is a no-op when already cleared', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const initial = { repo1: [wt] }
    store.setState({ worktreesByRepo: initial } as Partial<AppState>)

    store.getState().clearWorktreeUnread(wt.id)

    expect(store.getState().worktreesByRepo).toBe(initial)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })
})
