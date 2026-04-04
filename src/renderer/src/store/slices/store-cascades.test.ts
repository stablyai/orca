import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', () => ({
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

// Mock window.api before anything uses it
const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  repos: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({}),
    pickFolder: vi.fn().mockResolvedValue(null)
  },
  pty: {
    kill: vi.fn().mockResolvedValue(undefined)
  },
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    issue: vi.fn().mockResolvedValue(null)
  },
  settings: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined)
  },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  }
}

// @ts-expect-error -- mock
globalThis.window = { api: mockApi }

import {
  createTestStore,
  makeLayout,
  makeOpenFile,
  makeTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'

// ─── Tests ────────────────────────────────────────────────────────────

describe('removeWorktree cascade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.remove.mockResolvedValue(undefined)
  })

  it('cleans up all associated state on successful removal', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({ id: 'tab1', worktreeId }),
          makeTab({ id: 'tab2', worktreeId, sortOrder: 1 })
        ]
      },
      ptyIdsByTabId: {
        tab1: ['pty1'],
        tab2: ['pty2']
      },
      terminalLayoutsByTabId: {
        tab1: makeLayout(),
        tab2: makeLayout()
      },
      deleteStateByWorktreeId: {
        [worktreeId]: { isDeleting: false, error: null, canForceDelete: false }
      },
      fileSearchStateByWorktree: {
        [worktreeId]: {
          query: 'needle',
          caseSensitive: true,
          wholeWord: false,
          useRegex: false,
          includePattern: '*.ts',
          excludePattern: 'dist/**',
          results: { files: [], totalMatches: 0, truncated: false },
          loading: false,
          collapsedFiles: new Set(['/path/wt1/file.ts'])
        }
      },
      activeWorktreeId: worktreeId,
      activeTabId: 'tab1',
      openFiles: [makeOpenFile({ id: '/path/wt1/file.ts', worktreeId })],
      activeFileId: '/path/wt1/file.ts',
      activeTabType: 'editor',
      activeFileIdByWorktree: { [worktreeId]: '/path/wt1/file.ts' },
      activeTabTypeByWorktree: { [worktreeId]: 'editor' }
    })

    const result = await store.getState().removeWorktree(worktreeId)
    const s = store.getState()

    expect(result).toEqual({ ok: true })
    expect(s.worktreesByRepo['repo1']).toEqual([])
    expect(s.tabsByWorktree[worktreeId]).toBeUndefined()
    expect(s.ptyIdsByTabId['tab1']).toBeUndefined()
    expect(s.ptyIdsByTabId['tab2']).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab1']).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab2']).toBeUndefined()
    expect(s.deleteStateByWorktreeId[worktreeId]).toBeUndefined()
    expect(s.fileSearchStateByWorktree[worktreeId]).toBeUndefined()
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeTabId).toBeNull()
    expect(s.openFiles).toEqual([])
    expect(s.activeFileId).toBeNull()
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeFileIdByWorktree[worktreeId]).toBeUndefined()
    expect(s.activeTabTypeByWorktree[worktreeId]).toBeUndefined()
  })

  it('sets delete state with error and canForceDelete=true on failure', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    mockApi.worktrees.remove.mockRejectedValueOnce(new Error('branch has changes'))

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: { [worktreeId]: [makeTab({ id: 'tab1', worktreeId })] },
      ptyIdsByTabId: { tab1: ['pty1'] },
      terminalLayoutsByTabId: { tab1: makeLayout() },
      activeWorktreeId: worktreeId,
      activeTabId: 'tab1'
    })

    const result = await store.getState().removeWorktree(worktreeId)
    const s = store.getState()

    expect(result).toEqual({ ok: false, error: 'branch has changes' })
    expect(s.deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error: 'branch has changes',
      canForceDelete: true
    })
    // State NOT cleaned up
    expect(s.worktreesByRepo['repo1']).toHaveLength(1)
    expect(s.tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(s.activeWorktreeId).toBe(worktreeId)
  })

  it('sets canForceDelete=false when force=true removal fails', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    mockApi.worktrees.remove.mockRejectedValueOnce(new Error('fatal error'))

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    })

    const result = await store.getState().removeWorktree(worktreeId, true)
    const s = store.getState()

    expect(result).toEqual({ ok: false, error: 'fatal error' })
    expect(s.deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error: 'fatal error',
      canForceDelete: false
    })
  })

  it('does NOT affect other worktrees', async () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'
    const wt2 = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/path/wt2', displayName: 'wt2' })
        ]
      },
      tabsByWorktree: {
        [wt1]: [makeTab({ id: 'tab1', worktreeId: wt1 })],
        [wt2]: [makeTab({ id: 'tab2', worktreeId: wt2 })]
      },
      ptyIdsByTabId: {
        tab1: ['pty1'],
        tab2: ['pty2']
      },
      terminalLayoutsByTabId: {
        tab1: makeLayout(),
        tab2: makeLayout()
      },
      fileSearchStateByWorktree: {
        [wt1]: {
          query: 'old',
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
          includePattern: '',
          excludePattern: '',
          results: { files: [], totalMatches: 0, truncated: false },
          loading: false,
          collapsedFiles: new Set()
        },
        [wt2]: {
          query: 'keep',
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
          includePattern: '*.md',
          excludePattern: '',
          results: { files: [], totalMatches: 1, truncated: false },
          loading: false,
          collapsedFiles: new Set(['/path/wt2/notes.md'])
        }
      },
      activeWorktreeId: wt2,
      activeTabId: 'tab2'
    })

    await store.getState().removeWorktree(wt1)
    const s = store.getState()

    // wt2 is untouched
    expect(s.tabsByWorktree[wt2]).toHaveLength(1)
    expect(s.tabsByWorktree[wt2][0].id).toBe('tab2')
    expect(s.ptyIdsByTabId['tab2']).toEqual(['pty2'])
    expect(s.terminalLayoutsByTabId['tab2']).toEqual(makeLayout())
    expect(s.fileSearchStateByWorktree[wt2]?.query).toBe('keep')
    expect(s.activeWorktreeId).toBe(wt2)
    expect(s.activeTabId).toBe('tab2')

    // wt1 is gone
    expect(s.worktreesByRepo['repo1'].find((w) => w.id === wt1)).toBeUndefined()
    expect(s.tabsByWorktree[wt1]).toBeUndefined()
    expect(s.ptyIdsByTabId['tab1']).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab1']).toBeUndefined()
    expect(s.fileSearchStateByWorktree[wt1]).toBeUndefined()
  })

  it('shuts down terminals before asking the backend to remove the worktree', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const callOrder: string[] = []

    mockApi.pty.kill.mockImplementationOnce(async () => {
      callOrder.push('kill')
    })
    mockApi.worktrees.remove.mockImplementationOnce(async () => {
      callOrder.push('remove')
    })

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab1', worktreeId })]
      },
      ptyIdsByTabId: {
        tab1: ['pty1']
      },
      terminalLayoutsByTabId: {
        tab1: makeLayout()
      }
    })

    const result = await store.getState().removeWorktree(worktreeId)

    expect(result).toEqual({ ok: true })
    expect(callOrder).toEqual(['kill', 'remove'])
  })
})

describe('setActiveWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('does not rewrite sortOrder when selecting a worktree', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', sortOrder: 123, isUnread: false })]
      },
      refreshGitHubForWorktree: vi.fn()
    })

    store.getState().setActiveWorktree(worktreeId)

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.sortOrder).toBe(123)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })
})
