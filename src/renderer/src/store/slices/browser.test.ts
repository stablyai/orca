/* eslint-disable max-lines --
 * Why: this slice test keeps closely related browser-slice scenarios
 * (create/close, reopen, hydrate, shutdown) in one file so the shared
 * webview-registry mock setup stays consistent across behaviors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../components/browser-pane/webview-registry', () => ({
  destroyPersistentWebview: vi.fn()
}))

import { createTestStore, makeTabGroup, makeWorktree, seedStore } from './store-test-helpers'
import { destroyPersistentWebview } from '../../components/browser-pane/webview-registry'

describe('browser slice', () => {
  it('places a new tab in the target group when targetGroupId is provided', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/tmp/wt-1'
    seedStore(store, {
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabType: 'terminal',
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/tmp/wt-1' })]
      },
      groupsByWorktree: {
        [worktreeId]: [
          makeTabGroup({ id: 'terminal-group', worktreeId, activeTabId: null, tabOrder: [] }),
          makeTabGroup({ id: 'browser-group', worktreeId, activeTabId: null, tabOrder: [] })
        ]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'terminal-group' },
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const created = store.getState().createBrowserTab(worktreeId, 'https://example.com', {
      title: 'Example',
      targetGroupId: 'browser-group'
    })

    const unifiedTab = (store.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
      (t) => t.contentType === 'browser' && t.entityId === created.id
    )
    expect(unifiedTab?.groupId).toBe('browser-group')
  })

  it('falls back to active group when targetGroupId is not provided', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/tmp/wt-1'
    seedStore(store, {
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabType: 'terminal',
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/tmp/wt-1' })]
      },
      groupsByWorktree: {
        [worktreeId]: [
          makeTabGroup({ id: 'terminal-group', worktreeId, activeTabId: null, tabOrder: [] }),
          makeTabGroup({ id: 'browser-group', worktreeId, activeTabId: null, tabOrder: [] })
        ]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'terminal-group' },
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const created = store.getState().createBrowserTab(worktreeId, 'https://example.com', {
      title: 'Example'
    })

    const unifiedTab = (store.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
      (t) => t.contentType === 'browser' && t.entityId === created.id
    )
    expect(unifiedTab?.groupId).toBe('terminal-group')
  })

  it('reopens the most recently closed browser tab in the same worktree', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/tmp/wt-1'
    seedStore(store, {
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabType: 'browser',
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/tmp/wt-1'
          })
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [
          makeTabGroup({
            id: 'group-1',
            worktreeId,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      activeGroupIdByWorktree: {
        [worktreeId]: 'group-1'
      },
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const created = store.getState().createBrowserTab(worktreeId, 'https://example.com/docs', {
      title: 'Docs'
    })
    store.getState().closeBrowserTab(created.id)

    expect(store.getState().browserTabsByWorktree[worktreeId]).toBeUndefined()
    expect(store.getState().recentlyClosedBrowserTabsByWorktree[worktreeId]).toHaveLength(1)

    const reopened = store.getState().reopenClosedBrowserTab(worktreeId)

    expect(reopened).not.toBeNull()
    expect(reopened?.id).not.toBe(created.id)
    expect(reopened?.url).toBe('https://example.com/docs')
    expect(reopened?.title).toBe('Docs')
    expect(store.getState().browserTabsByWorktree[worktreeId]).toHaveLength(1)
    expect(store.getState().recentlyClosedBrowserTabsByWorktree[worktreeId]).toHaveLength(0)
  })

  it('reopens a multi-page workspace without duplicating the active URL (page order ≠ active first)', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/tmp/wt-1'
    seedStore(store, {
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabType: 'browser',
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/tmp/wt-1'
          })
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [
          makeTabGroup({
            id: 'group-1',
            worktreeId,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      activeGroupIdByWorktree: {
        [worktreeId]: 'group-1'
      },
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const ws = store.getState().createBrowserTab(worktreeId, 'https://example.com/a', {
      title: 'A'
    })
    store
      .getState()
      .createBrowserPage(ws.id, 'https://example.com/b', { title: 'B', activate: true })
    const beforeClose = store.getState().browserPagesByWorkspace[ws.id] ?? []
    expect(beforeClose).toHaveLength(2)
    expect(store.getState().browserTabsByWorktree[worktreeId]?.[0]?.url).toBe(
      'https://example.com/b'
    )

    store.getState().closeBrowserTab(ws.id)
    const reopened = store.getState().reopenClosedBrowserTab(worktreeId)
    expect(reopened).not.toBeNull()
    const pages = store.getState().browserPagesByWorkspace[reopened!.id] ?? []
    expect(pages).toHaveLength(2)
    const urls = new Set(pages.map((p) => p.url))
    expect(urls.has('https://example.com/a')).toBe(true)
    expect(urls.has('https://example.com/b')).toBe(true)
    expect(store.getState().browserTabsByWorktree[worktreeId]?.[0]?.url).toBe(
      'https://example.com/b'
    )
  })

  it('sets pending address-bar focus when focusAddressBar is true even for non-blank URLs', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/tmp/wt-1'
    seedStore(store, {
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabType: 'terminal',
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/tmp/wt-1' })]
      },
      groupsByWorktree: {
        [worktreeId]: [makeTabGroup({ id: 'group-1', worktreeId, activeTabId: null, tabOrder: [] })]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' },
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const created = store.getState().createBrowserTab(worktreeId, 'https://example.com/home', {
      title: 'Home',
      focusAddressBar: true
    })

    const pageId = store.getState().browserPagesByWorkspace[created.id]?.[0]?.id
    expect(pageId).toBeDefined()
    expect(store.getState().pendingAddressBarFocusByTabId[created.id]).toBe(true)
    expect(store.getState().pendingAddressBarFocusByPageId[pageId!]).toBe(true)
  })

  it('does not set pending address-bar focus for non-blank URLs when focusAddressBar is not set', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/tmp/wt-1'
    seedStore(store, {
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabType: 'terminal',
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/tmp/wt-1' })]
      },
      groupsByWorktree: {
        [worktreeId]: [makeTabGroup({ id: 'group-1', worktreeId, activeTabId: null, tabOrder: [] })]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' },
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const created = store.getState().createBrowserTab(worktreeId, 'https://example.com/home', {
      title: 'Home'
    })

    expect(store.getState().pendingAddressBarFocusByTabId[created.id]).toBeUndefined()
  })
})

describe('hydrateBrowserSession', () => {
  beforeEach(() => {
    vi.mocked(destroyPersistentWebview).mockClear()
  })

  // Why: design §3. hydrateBrowserSession drops workspaces whose worktree no
  // longer exists. Reducers are pure; destroy calls must bracket the set()
  // to mirror closeBrowserTab's contract and keep future callers (that might
  // run hydrate after webviews are live) safe without surgery.
  it('destroys webviews for dropped workspaces before committing state', () => {
    const store = createTestStore()
    const survivingWorktreeId = 'repo1::/tmp/wt-1'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: survivingWorktreeId, repoId: 'repo1', path: '/tmp/wt-1' })]
      },
      // Why: destroyWorkspaceWebviews reads pre-hydrate browserPagesByWorkspace
      // to resolve page ids. If the store is empty at hydrate time, the helper
      // falls back to the legacy workspace-id destroy (design §2 fallback). To
      // prove the page-id branch runs when pages exist in-store, seed them
      // first. Today's boot-only caller hits the fallback because hydrate is
      // the first thing to populate the map — the assertion here covers a
      // future re-hydrate after webviews are already live.
      browserPagesByWorkspace: {
        'workspace-drop': [
          {
            id: 'page-drop-a',
            workspaceId: 'workspace-drop',
            worktreeId: 'repo1::/tmp/wt-gone',
            url: 'about:blank',
            title: 'a',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          },
          {
            id: 'page-drop-b',
            workspaceId: 'workspace-drop',
            worktreeId: 'repo1::/tmp/wt-gone',
            url: 'about:blank',
            title: 'b',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      } as never
    })

    store.getState().hydrateBrowserSession({
      browserTabsByWorktree: {
        [survivingWorktreeId]: [
          {
            id: 'workspace-keep',
            worktreeId: survivingWorktreeId,
            label: 'keep',
            sessionProfileId: null,
            pageIds: ['page-keep'],
            activePageId: 'page-keep',
            url: 'about:blank',
            title: 'keep',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ],
        'repo1::/tmp/wt-gone': [
          {
            id: 'workspace-drop',
            worktreeId: 'repo1::/tmp/wt-gone',
            label: 'drop',
            sessionProfileId: null,
            pageIds: ['page-drop-a', 'page-drop-b'],
            activePageId: 'page-drop-a',
            url: 'about:blank',
            title: 'drop',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      browserPagesByWorkspace: {
        'workspace-drop': [
          {
            id: 'page-drop-a',
            workspaceId: 'workspace-drop',
            worktreeId: 'repo1::/tmp/wt-gone',
            url: 'about:blank',
            title: 'a',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          },
          {
            id: 'page-drop-b',
            workspaceId: 'workspace-drop',
            worktreeId: 'repo1::/tmp/wt-gone',
            url: 'about:blank',
            title: 'b',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ],
        'workspace-keep': [
          {
            id: 'page-keep',
            workspaceId: 'workspace-keep',
            worktreeId: survivingWorktreeId,
            url: 'about:blank',
            title: 'keep',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      }
    } as never)

    expect(destroyPersistentWebview).toHaveBeenCalledWith('page-drop-a')
    expect(destroyPersistentWebview).toHaveBeenCalledWith('page-drop-b')
    expect(destroyPersistentWebview).not.toHaveBeenCalledWith('page-keep')
    expect(store.getState().browserTabsByWorktree['repo1::/tmp/wt-gone']).toBeUndefined()
    expect(store.getState().browserPagesByWorkspace['workspace-drop']).toBeUndefined()
    expect(store.getState().browserTabsByWorktree[survivingWorktreeId]).toHaveLength(1)
  })

  it('redacts Kagi session tokens from hydrated browser history', () => {
    const store = createTestStore()

    store.getState().hydrateBrowserSession({
      browserUrlHistory: [
        {
          url: 'https://kagi.com/search?token=secret&q=hello+world',
          normalizedUrl: 'https://kagi.com/search?token=secret&q=hello+world',
          title: 'Kagi Search',
          lastVisitedAt: 1,
          visitCount: 1
        }
      ]
    } as never)

    expect(store.getState().browserUrlHistory).toEqual([
      {
        url: 'https://kagi.com/search?q=hello+world',
        normalizedUrl: 'https://kagi.com/search?q=hello+world',
        title: 'Kagi Search',
        lastVisitedAt: 1,
        visitCount: 1
      }
    ])
  })
})

// Why: setBrowserPageUrl is the single sink for URL updates from did-navigate,
// the agent-browser CDP nav-update IPC, and direct address-bar submits. Pin
// redaction at this boundary so a Kagi bearer token cannot reach the
// persisted BrowserPage.url field via any caller that forgot to redact.
describe('setBrowserPageUrl redaction', () => {
  it('redacts Kagi session tokens before storing the page URL', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/tmp/wt-1'
    seedStore(store, {
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabType: 'browser',
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/tmp/wt-1' })]
      },
      groupsByWorktree: {
        [worktreeId]: [makeTabGroup({ id: 'group-1', worktreeId, activeTabId: null, tabOrder: [] })]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' },
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const ws = store.getState().createBrowserTab(worktreeId, 'about:blank', { title: 'New Tab' })
    const pageId = store.getState().browserPagesByWorkspace[ws.id]?.[0]?.id
    expect(pageId).toBeDefined()

    store
      .getState()
      .setBrowserPageUrl(pageId!, 'https://kagi.com/search?token=secret&q=hello+world')

    const page = store.getState().browserPagesByWorkspace[ws.id]?.[0]
    expect(page?.url).toBe('https://kagi.com/search?q=hello+world')
    expect(store.getState().browserTabsByWorktree[worktreeId]?.[0]?.url).toBe(
      'https://kagi.com/search?q=hello+world'
    )
  })
})

// Why: the leak this PR fixes lives inside the thunk itself. removeWorktree
// and runSleepWorktree tests stub this thunk, so destroy-call regressions in
// its body would be invisible there. These tests pin the thunk directly.
describe('shutdownWorktreeBrowsers', () => {
  beforeEach(() => {
    vi.mocked(destroyPersistentWebview).mockClear()
  })

  function seedWorktree(store: ReturnType<typeof createTestStore>, worktreeId: string): void {
    seedStore(store, {
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabType: 'browser',
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/tmp/wt-1' })]
      },
      groupsByWorktree: {
        [worktreeId]: [makeTabGroup({ id: 'group-1', worktreeId, activeTabId: null, tabOrder: [] })]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' },
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })
  }

  it('destroys every page in every workspace of the target worktree', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/tmp/wt-1'
    seedWorktree(store, worktreeId)

    const ws1 = store.getState().createBrowserTab(worktreeId, 'https://example.com/a', {
      title: 'A'
    })
    const ws2 = store.getState().createBrowserTab(worktreeId, 'https://example.com/b', {
      title: 'B'
    })
    const ws1PageIds = (store.getState().browserPagesByWorkspace[ws1.id] ?? []).map((p) => p.id)
    const ws2PageIds = (store.getState().browserPagesByWorkspace[ws2.id] ?? []).map((p) => p.id)
    expect(ws1PageIds).toHaveLength(1)
    expect(ws2PageIds).toHaveLength(1)

    await store.getState().shutdownWorktreeBrowsers(worktreeId)

    // Why: this is the regression guard. If the thunk ever stops calling
    // destroyWorkspaceWebviews (or reverts to the old workspace-id keying),
    // this assertion fails loudly.
    for (const pageId of [...ws1PageIds, ...ws2PageIds]) {
      expect(destroyPersistentWebview).toHaveBeenCalledWith(pageId)
    }
    expect(store.getState().browserTabsByWorktree[worktreeId]).toBeUndefined()
    expect(store.getState().browserPagesByWorkspace[ws1.id]).toBeUndefined()
    expect(store.getState().browserPagesByWorkspace[ws2.id]).toBeUndefined()
  })

  it('destroys every page id of a multi-page workspace', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/tmp/wt-1'
    seedWorktree(store, worktreeId)

    const ws = store.getState().createBrowserTab(worktreeId, 'https://example.com/a', {
      title: 'A'
    })
    store
      .getState()
      .createBrowserPage(ws.id, 'https://example.com/b', { title: 'B', activate: false })
    store
      .getState()
      .createBrowserPage(ws.id, 'https://example.com/c', { title: 'C', activate: false })
    const pageIds = (store.getState().browserPagesByWorkspace[ws.id] ?? []).map((p) => p.id)
    expect(pageIds).toHaveLength(3)

    await store.getState().shutdownWorktreeBrowsers(worktreeId)

    for (const pageId of pageIds) {
      expect(destroyPersistentWebview).toHaveBeenCalledWith(pageId)
    }
  })

  it('leaves other worktrees untouched', async () => {
    const store = createTestStore()
    const targetWorktreeId = 'repo1::/tmp/wt-1'
    const otherWorktreeId = 'repo1::/tmp/wt-2'
    seedStore(store, {
      activeRepoId: 'repo1',
      activeWorktreeId: targetWorktreeId,
      activeTabType: 'browser',
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: targetWorktreeId, repoId: 'repo1', path: '/tmp/wt-1' }),
          makeWorktree({ id: otherWorktreeId, repoId: 'repo1', path: '/tmp/wt-2' })
        ]
      },
      groupsByWorktree: {
        [targetWorktreeId]: [
          makeTabGroup({
            id: 'group-1',
            worktreeId: targetWorktreeId,
            activeTabId: null,
            tabOrder: []
          })
        ],
        [otherWorktreeId]: [
          makeTabGroup({
            id: 'group-2',
            worktreeId: otherWorktreeId,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      activeGroupIdByWorktree: {
        [targetWorktreeId]: 'group-1',
        [otherWorktreeId]: 'group-2'
      },
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const targetWs = store.getState().createBrowserTab(targetWorktreeId, 'https://example.com/a', {
      title: 'A'
    })
    const otherWs = store.getState().createBrowserTab(otherWorktreeId, 'https://example.com/b', {
      title: 'B'
    })
    const otherPageIds = (store.getState().browserPagesByWorkspace[otherWs.id] ?? []).map(
      (p) => p.id
    )

    await store.getState().shutdownWorktreeBrowsers(targetWorktreeId)

    expect(store.getState().browserTabsByWorktree[targetWorktreeId]).toBeUndefined()
    expect(store.getState().browserPagesByWorkspace[targetWs.id]).toBeUndefined()
    expect(store.getState().browserTabsByWorktree[otherWorktreeId]).toHaveLength(1)
    expect(store.getState().browserPagesByWorkspace[otherWs.id]).toHaveLength(1)
    for (const pageId of otherPageIds) {
      expect(destroyPersistentWebview).not.toHaveBeenCalledWith(pageId)
    }
  })

  it('clears activeBrowserTabId and activeTabType when the target is the active worktree', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/tmp/wt-1'
    seedWorktree(store, worktreeId)

    const ws = store.getState().createBrowserTab(worktreeId, 'https://example.com/a', {
      title: 'A',
      activate: true
    })
    expect(store.getState().activeBrowserTabId).toBe(ws.id)

    await store.getState().shutdownWorktreeBrowsers(worktreeId)

    expect(store.getState().activeBrowserTabId).toBeNull()
    expect(store.getState().activeTabType).toBe('terminal')
    expect(store.getState().activeBrowserTabIdByWorktree[worktreeId]).toBeUndefined()
  })

  it('leaves global active browser alone when shutting down a background worktree', async () => {
    const store = createTestStore()
    const activeWorktreeId = 'repo1::/tmp/wt-1'
    const backgroundWorktreeId = 'repo1::/tmp/wt-2'
    seedStore(store, {
      activeRepoId: 'repo1',
      activeWorktreeId,
      activeTabType: 'browser',
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: activeWorktreeId, repoId: 'repo1', path: '/tmp/wt-1' }),
          makeWorktree({ id: backgroundWorktreeId, repoId: 'repo1', path: '/tmp/wt-2' })
        ]
      },
      groupsByWorktree: {
        [activeWorktreeId]: [
          makeTabGroup({
            id: 'group-1',
            worktreeId: activeWorktreeId,
            activeTabId: null,
            tabOrder: []
          })
        ],
        [backgroundWorktreeId]: [
          makeTabGroup({
            id: 'group-2',
            worktreeId: backgroundWorktreeId,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      activeGroupIdByWorktree: {
        [activeWorktreeId]: 'group-1',
        [backgroundWorktreeId]: 'group-2'
      },
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const activeWs = store
      .getState()
      .createBrowserTab(activeWorktreeId, 'https://example.com/active', {
        title: 'Active',
        activate: true
      })
    store.getState().createBrowserTab(backgroundWorktreeId, 'https://example.com/bg', {
      title: 'Background',
      // Why: createBrowserTab defaults to activate=true which would replace
      // activeBrowserTabId globally. This test needs the original active tab
      // to stay active so we can prove shutdown of the background worktree
      // doesn't disturb it.
      activate: false
    })
    expect(store.getState().activeBrowserTabId).toBe(activeWs.id)

    await store.getState().shutdownWorktreeBrowsers(backgroundWorktreeId)

    // Why: §1 shouldResetGlobalBrowser is gated on activeWorktreeId===target.
    // Shutting down a background worktree must not disturb what the user is
    // currently looking at.
    expect(store.getState().activeBrowserTabId).toBe(activeWs.id)
    expect(store.getState().activeTabType).toBe('browser')
  })

  it('is a no-op when the worktree has no browser tabs', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/tmp/wt-1'
    seedWorktree(store, worktreeId)
    // Override: this test needs activeTabType to start as terminal so we can
    // prove shutdown doesn't flip it.
    store.setState({ activeTabType: 'terminal' })

    await store.getState().shutdownWorktreeBrowsers(worktreeId)

    expect(destroyPersistentWebview).not.toHaveBeenCalled()
    expect(store.getState().activeTabType).toBe('terminal')
  })
})

// Why: focusBrowserTabInWorktree is the renderer side of `tab switch --focus`.
// The defining invariant is no cross-worktree screen theft: when multiple
// agents drive browsers in parallel worktrees, an agent focusing a tab in
// worktree X must never yank the user's view away from worktree Y.
describe('focusBrowserTabInWorktree', () => {
  function seedTwoWorktrees(
    store: ReturnType<typeof createTestStore>,
    activeWt: string,
    otherWt: string
  ): void {
    seedStore(store, {
      activeRepoId: 'repo1',
      activeWorktreeId: activeWt,
      activeTabType: 'terminal',
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: activeWt, repoId: 'repo1', path: '/tmp/wt-active' }),
          makeWorktree({ id: otherWt, repoId: 'repo1', path: '/tmp/wt-other' })
        ]
      },
      groupsByWorktree: {
        [activeWt]: [
          makeTabGroup({ id: 'g-active', worktreeId: activeWt, activeTabId: null, tabOrder: [] })
        ],
        [otherWt]: [
          makeTabGroup({ id: 'g-other', worktreeId: otherWt, activeTabId: null, tabOrder: [] })
        ]
      },
      activeGroupIdByWorktree: { [activeWt]: 'g-active', [otherWt]: 'g-other' },
      activeTabTypeByWorktree: { [activeWt]: 'terminal', [otherWt]: 'terminal' },
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {}
    })
  }

  it('does not yank activeWorktreeId when focusing a tab in a non-active worktree', () => {
    const store = createTestStore()
    const activeWt = 'repo1::/tmp/wt-active'
    const otherWt = 'repo1::/tmp/wt-other'
    seedTwoWorktrees(store, activeWt, otherWt)

    const ws = store.getState().createBrowserTab(otherWt, 'https://example.com/a', { title: 'A' })
    const pageId = (store.getState().browserPagesByWorkspace[ws.id] ?? [])[0]?.id
    expect(pageId).toBeDefined()
    // createBrowserTab on a non-active worktree leaves activeWorktreeId alone;
    // re-pin it here in case any future change to that path regresses it.
    store.setState({ activeWorktreeId: activeWt, activeTabType: 'terminal' })

    store.getState().focusBrowserTabInWorktree(otherWt, pageId!, { surfacePane: true })

    expect(store.getState().activeWorktreeId).toBe(activeWt)
    expect(store.getState().activeTabType).toBe('terminal')
  })

  it('updates per-worktree active tab and tab type for the targeted worktree even when not active', () => {
    const store = createTestStore()
    const activeWt = 'repo1::/tmp/wt-active'
    const otherWt = 'repo1::/tmp/wt-other'
    seedTwoWorktrees(store, activeWt, otherWt)

    const ws = store.getState().createBrowserTab(otherWt, 'https://example.com/a', { title: 'A' })
    const pageId = (store.getState().browserPagesByWorkspace[ws.id] ?? [])[0]?.id
    store.setState({ activeWorktreeId: activeWt, activeTabType: 'terminal' })

    store.getState().focusBrowserTabInWorktree(otherWt, pageId!, { surfacePane: true })

    // Per-worktree slots: pre-staged for whenever the user next visits otherWt.
    expect(store.getState().activeBrowserTabIdByWorktree[otherWt]).toBe(ws.id)
    expect(store.getState().activeTabTypeByWorktree[otherWt]).toBe('browser')
  })

  it('flips global activeBrowserTabId and activeTabType when targeting the active worktree with surfacePane', () => {
    const store = createTestStore()
    const activeWt = 'repo1::/tmp/wt-active'
    const otherWt = 'repo1::/tmp/wt-other'
    seedTwoWorktrees(store, activeWt, otherWt)

    const ws = store.getState().createBrowserTab(activeWt, 'https://example.com/a', { title: 'A' })
    const pageId = (store.getState().browserPagesByWorkspace[ws.id] ?? [])[0]?.id
    // Reset to terminal so we can prove --focus surfaces the pane.
    store.setState((s) => ({
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [activeWt]: 'terminal' }
    }))

    store.getState().focusBrowserTabInWorktree(activeWt, pageId!, { surfacePane: true })

    expect(store.getState().activeBrowserTabId).toBe(ws.id)
    expect(store.getState().activeTabType).toBe('browser')
  })

  it('without surfacePane, leaves activeTabType alone even on the active worktree', () => {
    const store = createTestStore()
    const activeWt = 'repo1::/tmp/wt-active'
    const otherWt = 'repo1::/tmp/wt-other'
    seedTwoWorktrees(store, activeWt, otherWt)

    const ws = store.getState().createBrowserTab(activeWt, 'https://example.com/a', { title: 'A' })
    const pageId = (store.getState().browserPagesByWorkspace[ws.id] ?? [])[0]?.id
    // Reset both globals and per-worktree slot so we can prove surfacePane=false
    // does NOT flip the user back into the browser pane (createBrowserTab
    // itself flips both because it activates the new tab).
    store.setState((s) => ({
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [activeWt]: 'terminal' }
    }))

    store.getState().focusBrowserTabInWorktree(activeWt, pageId!, { surfacePane: false })

    // Per-worktree active tab still pre-staged, but the user is still on terminal.
    expect(store.getState().activeBrowserTabIdByWorktree[activeWt]).toBe(ws.id)
    expect(store.getState().activeTabType).toBe('terminal')
    expect(store.getState().activeTabTypeByWorktree[activeWt]).toBe('terminal')
  })

  it('finds the owning workspace via pageIds for multi-page workspaces', () => {
    const store = createTestStore()
    const activeWt = 'repo1::/tmp/wt-active'
    const otherWt = 'repo1::/tmp/wt-other'
    seedTwoWorktrees(store, activeWt, otherWt)

    const ws = store.getState().createBrowserTab(otherWt, 'https://example.com/a', { title: 'A' })
    const pageB = store
      .getState()
      .createBrowserPage(ws.id, 'https://example.com/b', { title: 'B', activate: false })
    expect(pageB).not.toBeNull()

    store.getState().focusBrowserTabInWorktree(otherWt, pageB!.id, { surfacePane: true })

    // The workspace's activePageId must follow the focused page id, not its
    // first page. Renderer otherwise shows the wrong tab on next visit.
    const updatedWs = store.getState().browserTabsByWorktree[otherWt]?.find((t) => t.id === ws.id)
    expect(updatedWs?.activePageId).toBe(pageB!.id)
    expect(store.getState().activeBrowserTabIdByWorktree[otherWt]).toBe(ws.id)
  })

  it('is a no-op when the page id is not present in the targeted worktree', () => {
    const store = createTestStore()
    const activeWt = 'repo1::/tmp/wt-active'
    const otherWt = 'repo1::/tmp/wt-other'
    seedTwoWorktrees(store, activeWt, otherWt)

    const before = store.getState()
    before.focusBrowserTabInWorktree(otherWt, 'page-that-does-not-exist', { surfacePane: true })
    const after = store.getState()

    // Nothing globally or per-worktree should have moved. Best-effort: the
    // page may have closed between the bridge switching and the IPC arriving.
    expect(after.activeWorktreeId).toBe(before.activeWorktreeId)
    expect(after.activeTabType).toBe(before.activeTabType)
    expect(after.activeBrowserTabIdByWorktree[otherWt]).toBeUndefined()
  })

  it('surfaces the pane by default when no options are passed (active worktree)', () => {
    const store = createTestStore()
    const activeWt = 'repo1::/tmp/wt-active'
    const otherWt = 'repo1::/tmp/wt-other'
    seedTwoWorktrees(store, activeWt, otherWt)

    const ws = store.getState().createBrowserTab(activeWt, 'https://example.com/a', { title: 'A' })
    const pageId = (store.getState().browserPagesByWorkspace[ws.id] ?? [])[0]?.id
    store.setState((s) => ({
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [activeWt]: 'terminal' }
    }))

    store.getState().focusBrowserTabInWorktree(activeWt, pageId!)

    expect(store.getState().activeBrowserTabId).toBe(ws.id)
    expect(store.getState().activeTabType).toBe('browser')
    expect(store.getState().activeTabTypeByWorktree[activeWt]).toBe('browser')
  })
})
