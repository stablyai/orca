import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
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

  // Why: a stale unread flag on a closed tab renders a bell the user can never dismiss, since the tab is gone.
  it('drops unreadTerminalTabs for a closed tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const closing = store.getState().createTab(wt)
    const surviving = store.getState().createTab(wt)

    // Seed directly: mark actions refuse the active tab, but this test targets closeTab's cleanup, not the guards.
    store.setState({
      unreadTerminalTabs: {
        [closing.id]: true as const,
        [surviving.id]: true as const
      }
    })

    store.getState().closeTab(closing.id)

    const s = store.getState()
    expect(s.unreadTerminalTabs[closing.id]).toBeUndefined()
    // Siblings untouched.
    expect(s.unreadTerminalTabs[surviving.id]).toBe(true)
  })

  // Why: focus events that normally clear unread never arrive for dead PTYs, so the shutdown path must drop the flags itself.
  it('drops unread flags for every tab in a shutdown worktree', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const tabA = store.getState().createTab(wt)
    const tabB = store.getState().createTab(wt)

    // Seed flags directly (see closeTab test for why).
    store.setState({
      unreadTerminalTabs: {
        [tabA.id]: true as const,
        [tabB.id]: true as const
      }
    })

    await store.getState().shutdownWorktreeTerminals(wt)

    const s = store.getState()
    expect(s.unreadTerminalTabs[tabA.id]).toBeUndefined()
    expect(s.unreadTerminalTabs[tabB.id]).toBeUndefined()
  })

  // Why: browser-state mutations belong to shutdownWorktreeBrowsers only (design §1.3); reintroducing them here races both thunks.
  it('leaves browser state untouched when shutting down terminals', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeBrowserTabId: 'workspace-1',
      activeTabType: 'browser',
      browserTabsByWorktree: {
        [wt]: [
          {
            id: 'workspace-1',
            worktreeId: wt,
            label: 'ws1',
            sessionProfileId: null,
            pageIds: [],
            activePageId: null,
            url: 'about:blank',
            title: 'ws1',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      } as never,
      activeBrowserTabIdByWorktree: { [wt]: 'workspace-1' }
    })

    await store.getState().shutdownWorktreeTerminals(wt)

    const s = store.getState()
    expect(s.browserTabsByWorktree[wt]).toBeDefined()
    expect(s.activeBrowserTabIdByWorktree[wt]).toBe('workspace-1')
    expect(s.activeBrowserTabId).toBe('workspace-1')
    expect(s.activeTabType).toBe('browser')
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

  it('preserves terminal and unified tab map references when a live title repeats', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const first = store.getState().createTab(wt)
    store.getState().updateTabTitle(first.id, 'Claude Code')
    const tabsByWorktree = store.getState().tabsByWorktree
    const unifiedTabsByWorktree = store.getState().unifiedTabsByWorktree
    const sortEpoch = store.getState().sortEpoch

    store.getState().updateTabTitle(first.id, 'Claude Code')

    expect(store.getState().tabsByWorktree).toBe(tabsByWorktree)
    expect(store.getState().unifiedTabsByWorktree).toBe(unifiedTabsByWorktree)
    expect(store.getState().sortEpoch).toBe(sortEpoch)
  })

  it('repairs a stale unified tab label when a live title repeats', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const first = store.getState().createTab(wt)
    store.getState().updateTabTitle(first.id, 'Claude Code')
    const tabsByWorktree = store.getState().tabsByWorktree
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [wt]: state.unifiedTabsByWorktree[wt].map((tab) =>
          tab.contentType === 'terminal' && tab.entityId === first.id
            ? { ...tab, label: 'stale' }
            : tab
        )
      }
    }))

    store.getState().updateTabTitle(first.id, 'Claude Code')

    expect(store.getState().tabsByWorktree).toBe(tabsByWorktree)
    expect(
      store
        .getState()
        .unifiedTabsByWorktree[wt]?.find(
          (tab) => tab.contentType === 'terminal' && tab.entityId === first.id
        )?.label
    ).toBe('Claude Code')
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

  it('uses unified MRU selection when closing an active browser tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })

    const previous = store.getState().createBrowserTab(wt, 'https://previous.example.com')
    store.getState().createBrowserTab(wt, 'https://neighbor.example.com')
    const closing = store.getState().createBrowserTab(wt, 'https://closing.example.com')
    store.getState().setActiveBrowserTab(previous.id)
    store.getState().setActiveBrowserTab(closing.id)

    store.getState().closeBrowserTab(closing.id)

    expect(store.getState().activeBrowserTabId).toBe(previous.id)
    expect(store.getState().activeBrowserTabIdByWorktree[wt]).toBe(previous.id)
  })

  it('keeps the unified MRU target when closing the last browser tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })

    store.getState().createTab(wt)
    const previous = store.getState().createTab(wt)
    const closing = store.getState().createBrowserTab(wt, 'https://closing.example.com')

    store.getState().closeBrowserTab(closing.id)

    expect(store.getState().activeTabId).toBe(previous.id)
    expect(store.getState().activeTabType).toBe('terminal')
  })

  it('keeps a valid browser target for an inactive worktree after close', () => {
    const store = createTestStore()
    const activeWt = 'repo1::/path/active'
    const backgroundWt = 'repo1::/path/background'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: activeWt, repoId: 'repo1', path: '/path/active' }),
          makeWorktree({ id: backgroundWt, repoId: 'repo1', path: '/path/background' })
        ]
      },
      activeWorktreeId: activeWt
    })

    const previous = store
      .getState()
      .createBrowserTab(backgroundWt, 'https://previous.example.com', {
        activate: false
      })
    const closing = store.getState().createBrowserTab(backgroundWt, 'https://closing.example.com', {
      activate: false
    })
    store.setState({ activeBrowserTabIdByWorktree: { [backgroundWt]: closing.id } })

    store.getState().closeBrowserTab(closing.id)

    expect(store.getState().activeBrowserTabIdByWorktree[backgroundWt]).toBe(previous.id)
  })

  it('keeps the global browser target when closing a legacy tab without a unified wrapper', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })

    const previous = store.getState().createBrowserTab(wt, 'https://previous.example.com', {
      activate: false
    })
    const closing = store.getState().createBrowserTab(wt, 'https://closing.example.com', {
      activate: false
    })
    store.setState({
      unifiedTabsByWorktree: {},
      activeBrowserTabId: closing.id,
      activeBrowserTabIdByWorktree: { [wt]: closing.id }
    })

    store.getState().closeBrowserTab(closing.id)

    expect(store.getState().activeBrowserTabId).toBe(previous.id)
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
