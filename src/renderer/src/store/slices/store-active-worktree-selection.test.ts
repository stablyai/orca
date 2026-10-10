import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { buildWorktreeComparator } from '@/components/sidebar/smart-sort'
import {
  createTestStore,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

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
    // Why: selecting a worktree must not manufacture smart-sort activity; ordering comes from real work, not focus.
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
    worktrees.sort(buildWorktreeComparator('smart', repoMap, now, new Map()))

    expect(worktrees.map((worktree) => worktree.id)).toEqual([backgroundId, focusedId])
  })

  it('keeps the current right sidebar tab when switching worktrees', () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'
    const wt2 = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      rightSidebarTab: 'checks',
      rightSidebarTabByWorktree: { [wt1]: 'search' as never, [wt2]: 'explorer' }
    })

    store.getState().setActiveWorktree(wt1)
    expect(store.getState().rightSidebarTab).toBe('checks')

    store.getState().setActiveWorktree(wt2)
    expect(store.getState().rightSidebarTab).toBe('checks')

    store.getState().setActiveWorktree(wt1)
    expect(store.getState().rightSidebarTab).toBe('checks')
  })

  it('restores the Explorer files/search subview per worktree when switching', () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'
    const wt2 = 'repo1::/path/wt2'
    const wt3 = 'repo1::/path/wt3'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/path/wt2' }),
          makeWorktree({ id: wt3, repoId: 'repo1', path: '/path/wt3' })
        ]
      },
      rightSidebarTab: 'explorer',
      rightSidebarExplorerView: 'search',
      rightSidebarExplorerViewByWorktree: {
        [wt1]: 'search',
        [wt2]: 'files'
      }
    })

    store.getState().setActiveWorktree(wt1)
    expect(store.getState().rightSidebarExplorerView).toBe('search')

    store.getState().setActiveWorktree(wt2)
    expect(store.getState().rightSidebarExplorerView).toBe('files')

    store.getState().setActiveWorktree(wt3)
    expect(store.getState().rightSidebarExplorerView).toBe('files')

    store.getState().setActiveWorktree(wt1)
    expect(store.getState().rightSidebarExplorerView).toBe('search')
  })

  it('does not reset the right sidebar tab for worktrees without remembered sidebar state', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      rightSidebarTab: 'checks'
    })

    store.getState().setActiveWorktree(wt)

    expect(store.getState().rightSidebarTab).toBe('checks')
  })

  it('does not notify subscribers when reselecting the already-active reconciled worktree', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const tabId = 'terminal-1'
    const groupId = 'group-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabId: tabId,
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [wt]: 'terminal' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: tabId, worktreeId: wt, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { [tabId]: ['pty-1'] },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: tabId,
            entityId: tabId,
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
            activeTabId: tabId,
            tabOrder: [tabId]
          })
        ]
      },
      activeGroupIdByWorktree: { [wt]: groupId },
      layoutByWorktree: { [wt]: { type: 'leaf', groupId } },
      everActivatedWorktreeIds: new Set([wt]),
      refreshGitHubForWorktree: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    const before = store.getState()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.getState().setActiveWorktree(wt)

    unsubscribe()
    expect(listener).not.toHaveBeenCalled()
    expect(store.getState()).toBe(before)
  })

  it('does not clobber the current right sidebar tab when clearing the active worktree', () => {
    const store = createTestStore()

    seedStore(store, {
      activeWorktreeId: 'repo1::/path/wt1',
      rightSidebarTab: 'checks',
      rightSidebarTabByWorktree: { 'repo1::/path/wt1': 'search' as never }
    })

    store.getState().setActiveWorktree(null)

    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().rightSidebarTab).toBe('checks')
    expect(store.getState().rightSidebarTabByWorktree).toEqual({ 'repo1::/path/wt1': 'search' })
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
})
