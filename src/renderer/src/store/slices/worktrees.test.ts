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
    create: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta: vi.fn().mockResolvedValue(undefined)
  },
  pty: {
    kill: vi.fn().mockResolvedValue(undefined)
  },
  hooks: {
    check: vi.fn().mockResolvedValue({ hasHooks: false, hooks: null, mayNeedUpdate: false })
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
        trustedOrcaHooks: {},
        repos: [],
        openModal: vi.fn(),
        shutdownWorktreeTerminals: vi.fn().mockResolvedValue(undefined),
        shutdownWorktreeBrowsers: vi.fn().mockResolvedValue(undefined),
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
        editorViewMode: {},
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
        recentlyClosedBrowserTabsByWorktree: {},
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

  it('updates the repo entry when only the persisted base ref changes', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      baseRef: 'origin/main'
    })
    const refreshed = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      baseRef: 'upstream/release'
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

describe('updateWorktreeGitIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates branch identity from git status without fetching worktrees', () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      head: 'old-head',
      branch: 'refs/heads/main'
    })

    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 3 } as Partial<AppState>)

    store.getState().updateWorktreeGitIdentity('repo1::/path/wt1', {
      head: 'new-head',
      branch: 'refs/heads/feature'
    })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      head: 'new-head',
      branch: 'refs/heads/feature'
    })
    expect(store.getState().sortEpoch).toBe(4)
    expect(mockApi.worktrees.list).not.toHaveBeenCalled()
  })
})

describe('createWorktree base status merge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes linked work item and creation agent metadata through the create IPC payload', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      linkedIssue: 123,
      linkedPR: 456,
      createdWithAgent: 'codex'
    })
    mockApi.worktrees.create.mockResolvedValue({ worktree: wt })

    await store
      .getState()
      .createWorktree(
        'repo1',
        'feature',
        'origin/main',
        'inherit',
        undefined,
        'sidebar',
        'Feature Title',
        123,
        456,
        undefined,
        'codex'
      )

    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo1',
        name: 'feature',
        linkedIssue: 123,
        linkedPR: 456,
        createdWithAgent: 'codex'
      })
    )
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      linkedIssue: 123,
      linkedPR: 456,
      createdWithAgent: 'codex'
    })
  })

  it('does not overwrite a newer reconcile status with the initial checking status', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    mockApi.worktrees.create.mockImplementation(async () => {
      store.getState().updateWorktreeBaseStatus({
        repoId: 'repo1',
        worktreeId: wt.id,
        status: 'drift',
        base: 'origin/main',
        remote: 'origin',
        behind: 2,
        recentSubjects: ['new base commit']
      })
      return {
        worktree: wt,
        initialBaseStatus: {
          repoId: 'repo1',
          worktreeId: wt.id,
          status: 'checking',
          base: 'origin/main',
          remote: 'origin'
        }
      }
    })

    await store.getState().createWorktree('repo1', 'feature')

    expect(store.getState().baseStatusByWorktreeId[wt.id]).toMatchObject({
      status: 'drift',
      behind: 2
    })
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

  it('cleans up editorViewMode for files in the removed worktree', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repo1::/path/wt1',
          filePath: '/path/wt1/app.ts',
          relativePath: 'app.ts',
          language: 'typescript',
          isDirty: false,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      editorViewMode: {
        'file-1': 'changes' as const,
        'file-2': 'changes' as const
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().editorViewMode).toEqual({ 'file-2': 'changes' })
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

  it('clears recentlyClosedBrowserTabsByWorktree for the removed worktree', async () => {
    // Why: closeBrowserTab (which shutdownWorktreeBrowsers delegates to) pushes
    // each closed workspace into recentlyClosedBrowserTabsByWorktree for the
    // Cmd+Shift+T undo path. When the owning worktree is deleted those
    // snapshots reference entities that can never be restored — removeWorktree
    // must clear the worktree key symmetrically with browserTabsByWorktree
    // (design §1.1).
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    store.setState({
      worktreesByRepo: { repo1: [wt] },
      recentlyClosedBrowserTabsByWorktree: {
        'repo1::/path/wt1': [{ workspace: { id: 'workspace-1' }, pages: [] }],
        'repo1::/path/wt2': [{ workspace: { id: 'workspace-2' }, pages: [] }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().removeWorktree('repo1::/path/wt1')

    expect(store.getState().recentlyClosedBrowserTabsByWorktree).toEqual({
      'repo1::/path/wt2': [{ workspace: { id: 'workspace-2' }, pages: [] }]
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

// Why: design §4.4 — the hydration-time purge must be gated behind a
// per-repo success check (F1 regression) so a transient git error on one
// repo cannot silently wipe every persisted tabsByWorktree entry for that
// repo. An empty-but-successful fetch from a newly-cloned sibling repo is
// also unsafe to treat as authoritative on its own. Pins both halves of
// that contract plus the happy-path purge.
describe('fetchAllWorktrees hydration-time purge (design §4.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const repoA = {
    id: 'repoA',
    path: '/repos/a',
    displayName: 'a',
    badgeColor: '#000',
    addedAt: 0
  }
  const repoB = {
    id: 'repoB',
    path: '/repos/b',
    displayName: 'b',
    badgeColor: '#111',
    addedAt: 0
  }

  it('defers the purge when a sibling repo fetch fails (F1 regression)', async () => {
    const store = createTestStore()
    const wtA = makeWorktree({ id: 'repoA::/a/wt1', repoId: 'repoA', path: '/a/wt1' })
    const wtB = makeWorktree({ id: 'repoB::/b/wt1', repoId: 'repoB', path: '/b/wt1' })

    // Stub: repoA succeeds; repoB throws. Stale tabsByWorktree entry for
    // repoA::/a/stale must NOT be purged while any repo fetch is degraded.
    mockApi.worktrees.list.mockImplementation(async ({ repoId }: { repoId: string }) => {
      if (repoId === 'repoA') {
        return [wtA]
      }
      throw new Error('git error')
    })

    store.setState({
      repos: [repoA, repoB],
      worktreesByRepo: { repoB: [wtB] },
      tabsByWorktree: {
        'repoA::/a/stale': [{ id: 'tab-A-stale', worktreeId: 'repoA::/a/stale' }],
        'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(false)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoA::/a/stale': [{ id: 'tab-A-stale', worktreeId: 'repoA::/a/stale' }],
      'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
    })

    // After repoB recovers, the deferred purge fires for genuinely stale ids.
    mockApi.worktrees.list.mockImplementation(async ({ repoId }: { repoId: string }) => {
      if (repoId === 'repoA') {
        return [wtA]
      }
      return [wtB]
    })

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(true)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
    })
  })

  it('defers the purge when every repo succeeds but none returns worktrees (empty-sibling safety)', async () => {
    const store = createTestStore()

    // Both repos succeed but legitimately return empty (newly-cloned). The
    // union of valid ids would be empty — declaring that authoritative
    // would wipe every persisted tabsByWorktree entry. Must defer instead.
    mockApi.worktrees.list.mockResolvedValue([])

    store.setState({
      repos: [repoA, repoB],
      tabsByWorktree: {
        'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(false)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }]
    })
  })

  it('fires the purge once when every repo returns successfully with ≥1 worktree', async () => {
    const store = createTestStore()
    const wtA = makeWorktree({ id: 'repoA::/a/wt1', repoId: 'repoA', path: '/a/wt1' })
    const wtB = makeWorktree({ id: 'repoB::/b/wt1', repoId: 'repoB', path: '/b/wt1' })

    mockApi.worktrees.list.mockImplementation(async ({ repoId }: { repoId: string }) =>
      repoId === 'repoA' ? [wtA] : [wtB]
    )

    store.setState({
      repos: [repoA, repoB],
      tabsByWorktree: {
        'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }],
        'repoA::/a/zombie': [{ id: 'tab-zombie', worktreeId: 'repoA::/a/zombie' }],
        'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(store.getState().hasHydratedWorktreePurge).toBe(true)
    expect(mockApi.worktrees.list).toHaveBeenCalledTimes(2)
    expect(store.getState().tabsByWorktree).toEqual({
      'repoA::/a/wt1': [{ id: 'tab-A', worktreeId: 'repoA::/a/wt1' }],
      'repoB::/b/wt1': [{ id: 'tab-B', worktreeId: 'repoB::/b/wt1' }]
    })

    // Second call must not re-run the purge even if new stale ids appear.
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        'repoA::/a/new-zombie': [{ id: 'tab-new-zombie', worktreeId: 'repoA::/a/new-zombie' }]
      }
    } as unknown as Partial<AppState>)

    await store.getState().fetchAllWorktrees()

    expect(mockApi.worktrees.list).toHaveBeenCalledTimes(4)
    expect(store.getState().tabsByWorktree['repoA::/a/new-zombie']).toBeDefined()
  })
})

// Why: design §4.4 — purgeWorktreeTerminalState wipes every worktree-scoped
// map symmetrically so a single removed-worktree event cannot leave
// per-worktree entries stranded. The full cascade is already covered by
// removeWorktree tests above; this block exercises the action directly to
// confirm cross-map coverage (worktree key, tab id, file id, and top-level
// actives).
describe('purgeWorktreeTerminalState direct (design §4.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('wipes tab-id-keyed maps (terminalLayoutsByTabId, ptyIdsByTabId) and clears actives', () => {
    const store = createTestStore()

    store.setState({
      tabsByWorktree: {
        'repoA::/a/wt1': [
          { id: 'tab-1', worktreeId: 'repoA::/a/wt1' },
          { id: 'tab-2', worktreeId: 'repoA::/a/wt1' }
        ],
        'repoA::/a/wt2': [{ id: 'tab-3', worktreeId: 'repoA::/a/wt2' }]
      },
      terminalLayoutsByTabId: {
        'tab-1': { panes: [] },
        'tab-2': { panes: [] },
        'tab-3': { panes: [] }
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'], 'tab-3': ['pty-3'] },
      runtimePaneTitlesByTabId: { 'tab-1': 'claude', 'tab-3': 'bash' },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: 'repoA::/a/wt1',
          filePath: '/a/wt1/a.ts',
          relativePath: 'a.ts',
          language: 'typescript',
          isDirty: false,
          isPreview: false,
          mode: 'edit' as const
        }
      ],
      editorDrafts: { 'file-1': 'draft', 'file-99': 'other' },
      activeWorktreeId: 'repoA::/a/wt1',
      activeFileId: 'file-1',
      activeTabId: 'tab-1',
      activeTabType: 'editor' as const
    } as unknown as Partial<AppState>)

    store.getState().purgeWorktreeTerminalState(['repoA::/a/wt1'])

    const s = store.getState()
    expect(s.tabsByWorktree).toEqual({
      'repoA::/a/wt2': [{ id: 'tab-3', worktreeId: 'repoA::/a/wt2' }]
    })
    expect(s.terminalLayoutsByTabId).toEqual({ 'tab-3': { panes: [] } })
    expect(s.ptyIdsByTabId).toEqual({ 'tab-3': ['pty-3'] })
    expect(s.runtimePaneTitlesByTabId).toEqual({ 'tab-3': 'bash' })
    expect(s.openFiles).toEqual([])
    expect(s.editorDrafts).toEqual({ 'file-99': 'other' })
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeFileId).toBeNull()
    expect(s.activeTabId).toBeNull()
    expect(s.activeTabType).toBe('terminal')
  })

  it('is a no-op when the id list is empty', () => {
    const store = createTestStore()
    const before = {
      'repoA::/a/wt1': [{ id: 'tab-1', worktreeId: 'repoA::/a/wt1' }]
    }
    store.setState({ tabsByWorktree: before } as unknown as Partial<AppState>)

    store.getState().purgeWorktreeTerminalState([])

    expect(store.getState().tabsByWorktree).toBe(before)
  })
})

describe('markWorktreeVisited', () => {
  it('is monotonic: an older timestamp does not regress the stored value', () => {
    const store = createTestStore()
    store.getState().markWorktreeVisited('wt-1', 1000)
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(1000)

    store.getState().markWorktreeVisited('wt-1', 500)
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(1000)

    store.getState().markWorktreeVisited('wt-1', 1000)
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(1000)

    store.getState().markWorktreeVisited('wt-1', 2000)
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(2000)
  })

  it('seedActiveWorktreeLastVisitedIfMissing seeds only when missing', () => {
    const store = createTestStore()
    store.setState({
      activeWorktreeId: 'wt-1',
      lastVisitedAtByWorktreeId: {}
    } as Partial<AppState>)
    store.getState().seedActiveWorktreeLastVisitedIfMissing()
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBeTypeOf('number')

    const existing = store.getState().lastVisitedAtByWorktreeId['wt-1']
    store.getState().seedActiveWorktreeLastVisitedIfMissing()
    expect(store.getState().lastVisitedAtByWorktreeId['wt-1']).toBe(existing)
  })

  it('pruneLastVisitedTimestamps drops entries for unknown worktree IDs within hydrated repos', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      lastVisitedAtByWorktreeId: { 'repo1::/a': 100, 'repo1::/gone': 200 }
    } as Partial<AppState>)
    store.getState().pruneLastVisitedTimestamps()
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ 'repo1::/a': 100 })
  })

  it('pruneLastVisitedTimestamps preserves entries for not-yet-hydrated repos (e.g. SSH pre-connect)', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/a', repoId: 'repo1', path: '/a' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      lastVisitedAtByWorktreeId: { 'repo1::/a': 100, 'ssh-repo::/b': 200 }
    } as Partial<AppState>)
    store.getState().pruneLastVisitedTimestamps()
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
      'repo1::/a': 100,
      'ssh-repo::/b': 200
    })
  })
})
