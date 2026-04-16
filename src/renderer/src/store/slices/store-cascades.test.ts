/* eslint-disable max-lines */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildWorktreeComparator } from '@/components/sidebar/smart-sort'

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
  makeTabGroup,
  makeUnifiedTab,
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
          queryDetailsExpanded: true,
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
          queryDetailsExpanded: false,
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
          queryDetailsExpanded: true,
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
    const lastActivityAt = 123456

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            sortOrder: 123,
            lastActivityAt,
            isUnread: false
          })
        ]
      },
      refreshGitHubForWorktree: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    store.getState().setActiveWorktree(worktreeId)

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.sortOrder).toBe(123)
    expect(worktree.lastActivityAt).toBe(lastActivityAt)
    // Why: selecting a worktree should not manufacture smart-sort activity.
    // Persisted ordering signals come from real background work or edits, not focus.
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('clears unread on selection without manufacturing smart-sort activity', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const lastActivityAt = 123456

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            isUnread: true,
            lastActivityAt
          })
        ]
      },
      refreshGitHubForWorktree: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    store.getState().setActiveWorktree(worktreeId)

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.isUnread).toBe(false)
    expect(worktree.lastActivityAt).toBe(lastActivityAt)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId,
      updates: { isUnread: false }
    })
  })

  it('does not change smart-sort rank after selection when a background event bumps sortEpoch', () => {
    const store = createTestStore()
    const focusedId = 'repo1::/path/focused'
    const backgroundId = 'repo1::/path/background'
    const now = new Date('2026-04-16T12:00:00.000Z').getTime()

    vi.spyOn(Date, 'now').mockReturnValue(now)

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: focusedId,
            repoId: 'repo1',
            displayName: 'Focused',
            lastActivityAt: now - 2 * 60_000
          }),
          makeWorktree({
            id: backgroundId,
            repoId: 'repo1',
            displayName: 'Background',
            lastActivityAt: now - 60_000
          })
        ]
      },
      refreshGitHubForWorktree: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    store.getState().setActiveWorktree(focusedId)
    store.getState().bumpWorktreeActivity(backgroundId)

    const worktrees = [...store.getState().worktreesByRepo.repo1]
    const repoMap = new Map(store.getState().repos.map((repo) => [repo.id, repo]))
    worktrees.sort(buildWorktreeComparator('smart', {}, repoMap, null, now))

    expect(worktrees.map((worktree) => worktree.id)).toEqual([backgroundId, focusedId])
  })

  it('falls back to the worktree browser tab when the restored editor id belongs to a different worktree', () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'
    const wt2 = 'repo1::/path/wt2'
    const otherFileId = '/path/wt2/file.ts'
    const browserTabId = 'browser-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      openFiles: [makeOpenFile({ id: otherFileId, worktreeId: wt2 })],
      activeFileIdByWorktree: { [wt1]: otherFileId },
      browserTabsByWorktree: {
        [wt1]: [
          {
            id: browserTabId,
            worktreeId: wt1,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [wt1]: browserTabId },
      activeTabTypeByWorktree: { [wt1]: 'editor' }
    })

    store.getState().setActiveWorktree(wt1)

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(wt1)
    expect(s.activeBrowserTabId).toBe(browserTabId)
    expect(s.activeTabType).toBe('browser')
    expect(s.activeFileId).toBeNull()
  })

  it('prefers the unified active tab over stale legacy browser restore state', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const groupId = 'group-1'
    const terminalId = 'terminal-1'
    const browserTabId = 'browser-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: terminalId, worktreeId: wt })]
      },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: browserTabId,
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [wt]: browserTabId },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: 'tab-terminal-1',
            entityId: terminalId,
            worktreeId: wt,
            groupId,
            contentType: 'terminal'
          }),
          makeUnifiedTab({
            id: 'tab-browser-1',
            entityId: browserTabId,
            worktreeId: wt,
            groupId,
            contentType: 'browser'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: 'tab-terminal-1',
            tabOrder: ['tab-terminal-1', 'tab-browser-1']
          })
        ]
      },
      activeGroupIdByWorktree: { [wt]: groupId }
    })

    store.getState().setActiveWorktree(wt)

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(wt)
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeTabTypeByWorktree[wt]).toBe('terminal')
    expect(s.activeTabId).toBe(terminalId)
    expect(s.activeBrowserTabId).toBe(browserTabId)
  })

  it('ignores stale unified tabs and falls back to terminal-first activation for empty groups', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const groupId = 'group-1'
    const browserTabId = 'browser-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: browserTabId,
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [wt]: browserTabId },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: 'stale-terminal-tab',
            entityId: 'missing-terminal',
            worktreeId: wt,
            groupId,
            contentType: 'terminal'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: 'stale-terminal-tab',
            tabOrder: ['stale-terminal-tab']
          })
        ]
      },
      activeGroupIdByWorktree: { [wt]: groupId }
    })

    store.getState().setActiveWorktree(wt)

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(wt)
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeBrowserTabId).toBe(browserTabId)
    expect(s.activeTabId).toBeNull()
    expect(s.unifiedTabsByWorktree[wt]).toEqual([])
    expect(s.groupsByWorktree[wt][0].activeTabId).toBeNull()
  })

  it('creates a root tab group when the first terminal opens in a worktree', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const terminal = store.getState().createTab(wt)
    const state = store.getState()
    const groups = state.groupsByWorktree[wt] ?? []
    const unifiedTabs = state.unifiedTabsByWorktree[wt] ?? []

    expect(groups).toHaveLength(1)
    expect(state.activeGroupIdByWorktree[wt]).toBe(groups[0].id)
    expect(state.layoutByWorktree[wt]).toEqual({ type: 'leaf', groupId: groups[0].id })
    expect(unifiedTabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: terminal.id,
          entityId: terminal.id,
          worktreeId: wt,
          groupId: groups[0].id,
          contentType: 'terminal'
        })
      ])
    )
    expect(groups[0].activeTabId).toBe(terminal.id)
    expect(groups[0].tabOrder).toEqual([terminal.id])
  })

  it('syncs the global active surface when focusing a different split group', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const terminalTabId = 'terminal-1'
    const editorFileId = '/path/wt1/src/index.ts'
    const terminalGroupId = 'group-terminal'
    const editorGroupId = 'group-editor'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'terminal',
      activeTabId: terminalTabId,
      activeTabIdByWorktree: { [wt]: terminalTabId },
      activeFileId: editorFileId,
      activeFileIdByWorktree: { [wt]: editorFileId },
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: terminalTabId, worktreeId: wt })]
      },
      openFiles: [makeOpenFile({ id: editorFileId, worktreeId: wt, filePath: editorFileId })],
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: terminalTabId,
            entityId: terminalTabId,
            worktreeId: wt,
            groupId: terminalGroupId,
            contentType: 'terminal'
          }),
          makeUnifiedTab({
            id: 'editor-view-1',
            entityId: editorFileId,
            worktreeId: wt,
            groupId: editorGroupId,
            contentType: 'editor',
            label: 'src/index.ts'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: terminalGroupId,
            worktreeId: wt,
            activeTabId: terminalTabId,
            tabOrder: [terminalTabId]
          }),
          makeTabGroup({
            id: editorGroupId,
            worktreeId: wt,
            activeTabId: 'editor-view-1',
            tabOrder: ['editor-view-1']
          })
        ]
      },
      layoutByWorktree: {
        [wt]: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: terminalGroupId },
          second: { type: 'leaf', groupId: editorGroupId }
        }
      },
      activeGroupIdByWorktree: { [wt]: terminalGroupId }
    })

    store.getState().focusGroup(wt, editorGroupId)

    const s = store.getState()
    expect(s.activeGroupIdByWorktree[wt]).toBe(editorGroupId)
    expect(s.activeTabType).toBe('editor')
    expect(s.activeTabTypeByWorktree[wt]).toBe('editor')
    expect(s.activeFileId).toBe(editorFileId)
    expect(s.activeFileIdByWorktree[wt]).toBe(editorFileId)
    expect(s.activeTabId).toBe(terminalTabId)
  })

  it('promotes the next tab in the focused split into the global active surface on close', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const terminalTabId = 'terminal-1'
    const browserTabId = 'browser-1'
    const groupId = 'group-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'browser',
      activeBrowserTabId: browserTabId,
      activeBrowserTabIdByWorktree: { [wt]: browserTabId },
      activeTabId: terminalTabId,
      activeTabIdByWorktree: { [wt]: terminalTabId },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: terminalTabId, worktreeId: wt })]
      },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: browserTabId,
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: terminalTabId,
            entityId: terminalTabId,
            worktreeId: wt,
            groupId,
            contentType: 'terminal'
          }),
          makeUnifiedTab({
            id: 'browser-view-1',
            entityId: browserTabId,
            worktreeId: wt,
            groupId,
            contentType: 'browser',
            label: 'Example'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: 'browser-view-1',
            tabOrder: [terminalTabId, 'browser-view-1']
          })
        ]
      },
      layoutByWorktree: {
        [wt]: { type: 'leaf', groupId }
      },
      activeGroupIdByWorktree: { [wt]: groupId }
    })

    store.getState().closeBrowserTab(browserTabId)

    const s = store.getState()
    expect(s.groupsByWorktree[wt]?.[0]?.activeTabId).toBe(terminalTabId)
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeTabTypeByWorktree[wt]).toBe('terminal')
    expect(s.activeTabId).toBe(terminalTabId)
    expect(s.activeBrowserTabId).toBeNull()
    expect(s.activeBrowserTabIdByWorktree[wt]).toBeNull()
  })

  it('promotes the sibling group into the global active surface when closing a focused empty split', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const editorFileId = '/path/wt1/src/index.ts'
    const emptyGroupId = 'group-empty'
    const editorGroupId = 'group-editor'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      activeFileId: editorFileId,
      activeFileIdByWorktree: { [wt]: editorFileId },
      openFiles: [makeOpenFile({ id: editorFileId, worktreeId: wt, filePath: editorFileId })],
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: 'editor-view-1',
            entityId: editorFileId,
            worktreeId: wt,
            groupId: editorGroupId,
            contentType: 'editor',
            label: 'src/index.ts'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: emptyGroupId,
            worktreeId: wt,
            activeTabId: null,
            tabOrder: []
          }),
          makeTabGroup({
            id: editorGroupId,
            worktreeId: wt,
            activeTabId: 'editor-view-1',
            tabOrder: ['editor-view-1']
          })
        ]
      },
      layoutByWorktree: {
        [wt]: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: emptyGroupId },
          second: { type: 'leaf', groupId: editorGroupId }
        }
      },
      activeGroupIdByWorktree: { [wt]: emptyGroupId }
    })

    store.getState().closeEmptyGroup(wt, emptyGroupId)

    const s = store.getState()
    expect(s.groupsByWorktree[wt]?.map((group) => group.id)).toEqual([editorGroupId])
    expect(s.activeGroupIdByWorktree[wt]).toBe(editorGroupId)
    expect(s.activeTabType).toBe('editor')
    expect(s.activeTabTypeByWorktree[wt]).toBe('editor')
    expect(s.activeFileId).toBe(editorFileId)
    expect(s.activeFileIdByWorktree[wt]).toBe(editorFileId)
  })

  it('reuses the lowest available terminal number after closes', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const first = store.getState().createTab(wt)
    const second = store.getState().createTab(wt)

    expect(first.title).toBe('Terminal 1')
    expect(second.title).toBe('Terminal 2')

    store.getState().closeTab(first.id)
    store.getState().closeTab(second.id)

    const replacement = store.getState().createTab(wt)
    expect(replacement.title).toBe('Terminal 1')
  })

  it('returns to the landing state when closing the last terminal tab in the active worktree', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const groupId = 'group-1'
    const tabId = 'tab-1'
    const unifiedTabId = 'unified-tab-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabId: tabId,
      activeTabType: 'terminal',
      activeTabIdByWorktree: { [wt]: tabId },
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: tabId, worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: unifiedTabId,
            entityId: tabId,
            worktreeId: wt,
            groupId,
            contentType: 'terminal',
            label: 'Terminal 1'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: unifiedTabId,
            tabOrder: [unifiedTabId]
          })
        ]
      },
      activeGroupIdByWorktree: { [wt]: groupId },
      layoutByWorktree: {
        [wt]: { type: 'leaf', groupId }
      }
    })

    store.getState().closeTab(tabId)

    const s = store.getState()
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeTabId).toBeNull()
    expect(s.tabsByWorktree[wt]).toEqual([])
    expect(s.unifiedTabsByWorktree[wt]).toEqual([])
  })

  it('keeps terminal numbering stable when a live agent renames an existing tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const first = store.getState().createTab(wt)
    store.getState().updateTabTitle(first.id, 'Claude Code')

    const second = store.getState().createTab(wt)

    expect(store.getState().tabsByWorktree[wt]?.[0]).toMatchObject({
      id: first.id,
      title: 'Claude Code',
      defaultTitle: 'Terminal 1'
    })
    expect(second.title).toBe('Terminal 2')
    expect(second.defaultTitle).toBe('Terminal 2')
  })

  it('falls back to the stable terminal label when a live title clears', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const first = store.getState().createTab(wt)
    store.getState().updateTabTitle(first.id, 'Claude Code')
    store.getState().updateTabTitle(first.id, '')

    expect(store.getState().tabsByWorktree[wt]?.[0]).toMatchObject({
      id: first.id,
      title: 'Terminal 1',
      defaultTitle: 'Terminal 1'
    })
    expect(
      store
        .getState()
        .unifiedTabsByWorktree[wt]?.find(
          (tab) => tab.contentType === 'terminal' && tab.entityId === first.id
        )
    ).toMatchObject({
      label: 'Terminal 1'
    })
  })

  it('clears stale background browser tab type when closing the last browser tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: null,
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: 'browser-1',
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [wt]: 'browser-1' },
      activeTabTypeByWorktree: { [wt]: 'browser' }
    })

    store.getState().closeBrowserTab('browser-1')

    expect(store.getState().activeTabTypeByWorktree[wt]).toBe('terminal')
    expect(store.getState().activeBrowserTabIdByWorktree[wt]).toBeNull()
  })

  it('falls back to editor globally when closing the last active browser tab in a worktree with files', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const fileId = '/path/wt1/src/index.ts'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'browser',
      openFiles: [makeOpenFile({ id: fileId, worktreeId: wt, filePath: fileId })],
      activeFileId: fileId,
      activeFileIdByWorktree: { [wt]: fileId },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: 'browser-1',
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabId: 'browser-1',
      activeBrowserTabIdByWorktree: { [wt]: 'browser-1' }
    })

    store.getState().closeBrowserTab('browser-1')

    const s = store.getState()
    expect(s.activeTabType).toBe('editor')
    expect(s.activeTabTypeByWorktree[wt]).toBe('editor')
    expect(s.activeFileId).toBe(fileId)
  })

  it('does not switch the global surface when creating a browser tab for a background worktree', () => {
    const store = createTestStore()
    const activeWt = 'repo1::/path/wt1'
    const backgroundWt = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: activeWt, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: backgroundWt, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      activeWorktreeId: activeWt,
      activeTabType: 'terminal',
      tabsByWorktree: {
        [activeWt]: [makeTab({ id: 'terminal-1', worktreeId: activeWt })],
        [backgroundWt]: [makeTab({ id: 'terminal-2', worktreeId: backgroundWt })]
      }
    })

    const browserTab = store
      .getState()
      .createBrowserTab(backgroundWt, 'https://example.com', { activate: true })

    const s = store.getState()
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeTabTypeByWorktree[backgroundWt]).toBe('browser')
    expect(s.activeBrowserTabIdByWorktree[backgroundWt]).toBe(browserTab.id)
  })

  it('queues and consumes a one-shot address-bar focus request for a fresh blank browser tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'terminal',
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      }
    })

    const browserTab = store.getState().createBrowserTab(wt, 'about:blank', { activate: true })

    expect(store.getState().pendingAddressBarFocusByTabId[browserTab.id]).toBe(true)
    expect(store.getState().consumeAddressBarFocusRequest(browserTab.id)).toBe(true)
    expect(store.getState().consumeAddressBarFocusRequest(browserTab.id)).toBe(false)
  })

  it('does not queue address-bar focus for background or already-navigated browser tabs', () => {
    const store = createTestStore()
    const activeWt = 'repo1::/path/wt1'
    const backgroundWt = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: activeWt, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: backgroundWt, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      activeWorktreeId: activeWt,
      activeTabType: 'terminal',
      tabsByWorktree: {
        [activeWt]: [makeTab({ id: 'terminal-1', worktreeId: activeWt })],
        [backgroundWt]: [makeTab({ id: 'terminal-2', worktreeId: backgroundWt })]
      }
    })

    const backgroundBlankTab = store
      .getState()
      .createBrowserTab(backgroundWt, 'about:blank', { activate: true })
    const activeNavigatedTab = store
      .getState()
      .createBrowserTab(activeWt, 'https://example.com', { activate: true })

    expect(store.getState().pendingAddressBarFocusByTabId[backgroundBlankTab.id]).toBeUndefined()
    expect(store.getState().pendingAddressBarFocusByTabId[activeNavigatedTab.id]).toBeUndefined()
  })

  it('drops a pending address-bar focus request when the new browser tab closes before mount', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'terminal',
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      }
    })

    const browserTab = store.getState().createBrowserTab(wt, 'about:blank', { activate: true })
    expect(store.getState().pendingAddressBarFocusByTabId[browserTab.id]).toBe(true)

    store.getState().closeBrowserTab(browserTab.id)

    expect(store.getState().pendingAddressBarFocusByTabId[browserTab.id]).toBeUndefined()
  })

  it('restores terminal surface when switching to a worktree that was last on a terminal tab with open files', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const fileId = '/path/wt1/src/index.ts'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: null,
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      },
      openFiles: [makeOpenFile({ id: fileId, worktreeId: wt, filePath: fileId })],
      activeFileIdByWorktree: { [wt]: fileId },
      // User was on the terminal, not the editor
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      refreshGitHubForWorktree: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    store.getState().setActiveWorktree(wt)

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(wt)
    expect(s.activeTabType).toBe('terminal')
    // File ID should still be tracked for background state
    expect(s.activeFileId).toBe(fileId)
  })
})
