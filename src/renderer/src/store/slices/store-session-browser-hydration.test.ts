import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  RemoteBrowserPageSession,
  type RemoteBrowserPageSessionDeps
} from '@/components/browser-pane/stream-remote/remote-browser-page-session'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { resetRestoredBrowserClientHostAttachForTests } from '@/runtime/restored-client-hosted-browser-host-attach'
import { createTestStore, makeWorktree, makeTab } from './store-test-helpers'
import { createStoreSessionMockApi, makeBrowserTab } from './store-session-test-harness'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreSessionMockApi()

describe('hydrateBrowserSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to the first valid browser tab when the persisted active browser tab is missing', () => {
    const store = createTestStore()
    const validWt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: validWt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: validWt
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: validWt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [validWt]: [
          makeBrowserTab({ id: 'browser-1', worktreeId: validWt, url: 'https://example.com' }),
          makeBrowserTab({ id: 'browser-2', worktreeId: validWt, url: 'https://openai.com' })
        ]
      },
      activeBrowserTabIdByWorktree: {
        [validWt]: 'missing-browser-id'
      },
      activeTabTypeByWorktree: {
        [validWt]: 'browser'
      }
    })

    const s = store.getState()
    expect(s.browserTabsByWorktree[validWt]).toHaveLength(2)
    expect(s.activeBrowserTabIdByWorktree[validWt]).toBe('browser-1')
    expect(s.activeBrowserTabId).toBe('browser-1')
  })

  it('synthesizes a page for a browser workspace whose persisted page list is empty', () => {
    // Why: session salvage drops a corrupt page by rebuilding the array, so the
    // key survives holding []. Treating that as "has pages" restores a workspace
    // with no page at all — a dead about:blank tab nothing prunes or reloads.
    const store = createTestStore()
    const validWt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: validWt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: validWt
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: validWt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [validWt]: [
          makeBrowserTab({ id: 'browser-1', worktreeId: validWt, url: 'https://example.com' })
        ]
      },
      browserPagesByWorkspace: { 'browser-1': [] }
    })

    const s = store.getState()
    expect(s.browserPagesByWorkspace['browser-1']).toHaveLength(1)
    expect(s.browserPagesByWorkspace['browser-1'][0].url).toBe('https://example.com')
    expect(s.browserTabsByWorktree[validWt][0].activePageId).toBe(
      s.browserPagesByWorkspace['browser-1'][0].id
    )
  })

  it('drops legacy window close bypass state during hydration', () => {
    const store = createTestStore()
    const validWt = 'repo1::/path/wt1'
    const legacyPage: BrowserPage & { allowWindowClose: boolean } = {
      id: 'page-1',
      workspaceId: 'browser-1',
      worktreeId: validWt,
      url: 'https://example.com',
      title: 'Example',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1,
      allowWindowClose: true
    }

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: validWt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: validWt
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: validWt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [validWt]: [makeBrowserTab({ id: 'browser-1', worktreeId: validWt, url: legacyPage.url })]
      },
      browserPagesByWorkspace: { 'browser-1': [legacyPage] },
      activeBrowserTabIdByWorktree: { [validWt]: 'browser-1' }
    })

    expect(store.getState().browserPagesByWorkspace['browser-1']?.[0]).not.toHaveProperty(
      'allowWindowClose'
    )
  })

  it('restores floating workspace browser tabs without a repo worktree', () => {
    const store = createTestStore()

    store.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    store.getState().hydrateBrowserSession({
      activeRepoId: null,
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          makeBrowserTab({
            id: 'floating-browser-1',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            url: 'https://example.com'
          })
        ]
      },
      activeBrowserTabIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-browser-1'
      },
      activeTabTypeByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'browser' }
    })

    const s = store.getState()
    expect(s.browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(s.activeBrowserTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe('floating-browser-1')
  })

  it('restores activeTabTypeByWorktree for browser worktrees when hydrateEditorSession was a no-op', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      // Simulate hydrateEditorSession returning {} (no editor files) — activeTabTypeByWorktree stays empty.
      activeTabTypeByWorktree: {}
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [wt]: [makeBrowserTab({ id: 'browser-1', worktreeId: wt, url: 'https://example.com' })]
      },
      activeBrowserTabIdByWorktree: { [wt]: 'browser-1' },
      activeTabTypeByWorktree: { [wt]: 'browser' }
    })

    const s = store.getState()
    // hydrateBrowserSession must merge 'browser' into activeTabTypeByWorktree, else setActiveWorktree defaults to 'terminal' → blank screen.
    expect(s.activeTabTypeByWorktree[wt]).toBe('browser')
    expect(s.activeTabType).toBe('browser')
    expect(s.activeBrowserTabId).toBe('browser-1')
  })

  it('does not overwrite existing activeTabTypeByWorktree entries from hydrateEditorSession', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      // Simulate hydrateEditorSession having already set this to 'editor'
      activeTabTypeByWorktree: { [wt]: 'editor' }
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [wt]: [makeBrowserTab({ id: 'browser-1', worktreeId: wt, url: 'https://example.com' })]
      },
      activeBrowserTabIdByWorktree: { [wt]: 'browser-1' },
      activeTabTypeByWorktree: { [wt]: 'browser' }
    })

    const s = store.getState()
    // The existing 'editor' entry set by hydrateEditorSession must not be overwritten
    expect(s.activeTabTypeByWorktree[wt]).toBe('editor')
  })

  it('drops browser tabs for invalid worktrees', () => {
    const store = createTestStore()
    const validWt = 'repo1::/path/wt1'
    const invalidWt = 'repo1::/path/gone'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: validWt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: validWt
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: validWt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [validWt]: [
          makeBrowserTab({ id: 'browser-1', worktreeId: validWt, url: 'https://example.com' })
        ],
        [invalidWt]: [
          makeBrowserTab({ id: 'browser-bad', worktreeId: invalidWt, url: 'https://bad.invalid' })
        ]
      },
      activeBrowserTabIdByWorktree: {
        [validWt]: 'browser-1',
        [invalidWt]: 'browser-bad'
      }
    })

    const s = store.getState()
    expect(s.browserTabsByWorktree[validWt]).toHaveLength(1)
    expect(s.browserTabsByWorktree[invalidWt]).toBeUndefined()
    expect(s.activeBrowserTabIdByWorktree[invalidWt]).toBeUndefined()
  })

  it('normalizes stale browser tab-type restores when the worktree has no browser tabs', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      activeTabType: 'browser'
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: 'terminal-1',
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      },
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      activeTabTypeByWorktree: { [wt]: 'browser' }
    })

    const s = store.getState()
    expect(s.activeTabTypeByWorktree[wt]).toBe('terminal')
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeBrowserTabIdByWorktree[wt]).toBeUndefined()
    expect(s.activeBrowserTabId).toBeNull()
  })
})

describe('hydrateBrowserSession remote page handle seeding', () => {
  const WT = 'repo1::/path/wt1'

  function createHydratedStore(page: Partial<BrowserPage> & { id: string }) {
    const store = createTestStore()
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: WT
    })
    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: WT,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [WT]: [makeBrowserTab({ id: 'workspace-1', worktreeId: WT, url: 'https://example.com/' })]
      },
      browserPagesByWorkspace: {
        'workspace-1': [
          {
            workspaceId: 'workspace-1',
            worktreeId: WT,
            url: 'https://example.com/',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1,
            ...page
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [WT]: 'workspace-1' }
    })
    return store
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetRestoredBrowserClientHostAttachForTests()
  })

  // Why the wiring and not just the helper: the runtime only hands retained pages back when this
  // desktop attaches as a host, and nothing else in the boot chain starts one after a relaunch.
  it('starts the browser client host for a restored client-hosted page', () => {
    createHydratedStore({
      id: 'page-1',
      browserRuntimeEnvironmentId: 'env-1',
      remoteBrowserPageId: 'remote-page-1',
      remoteBrowserPageClientHosted: true
    })

    expect(mockApi.runtimeEnvironments.prepareBrowserClientHostPlacement).toHaveBeenCalledWith({
      selector: 'env-1',
      preference: 'auto'
    })
  })

  it('starts no browser client host for a restored server-hosted page', () => {
    createHydratedStore({
      id: 'page-1',
      browserRuntimeEnvironmentId: 'env-1',
      remoteBrowserPageId: 'remote-page-1'
    })

    expect(mockApi.runtimeEnvironments.prepareBrowserClientHostPlacement).not.toHaveBeenCalled()
  })

  // Why: without a seeded handle the restored pane sees no remote page at all and falls through to
  // a bare browser.tabCreate — a silent downgrade to a blank server page.
  it('seeds a remote page handle for a restored client-hosted page', () => {
    const store = createHydratedStore({
      id: 'page-1',
      browserRuntimeEnvironmentId: 'env-1',
      remoteBrowserPageId: 'remote-page-1',
      remoteBrowserPageClientHosted: true
    })

    expect(store.getState().remoteBrowserPageHandlesByPageId['page-1']).toEqual({
      environmentId: 'env-1',
      remotePageId: 'remote-page-1',
      restoredFromSession: true,
      restoredClientHosted: true
    })
  })

  // Why no placement: the persisted generations are from the host lease that just died, and
  // attaching against them strands the pane on the unavailable notice.
  it('seeds no placement for a restored client-hosted page', () => {
    const store = createHydratedStore({
      id: 'page-1',
      browserRuntimeEnvironmentId: 'env-1',
      remoteBrowserPageId: 'remote-page-1',
      remoteBrowserPageClientHosted: true
    })

    expect(store.getState().remoteBrowserPageHandlesByPageId['page-1']?.placement).toBeUndefined()
  })

  // Why nothing is seeded here: a server-hosted page lives on the runtime, and a runtime that
  // restarted while this desktop was closed no longer has it. A seeded handle sends the pane down
  // the adopt branch, which answers browser_tab_not_found by deleting the row.
  it('seeds no handle for a restored server-hosted page', () => {
    const store = createHydratedStore({
      id: 'page-1',
      browserRuntimeEnvironmentId: 'env-1',
      remoteBrowserPageId: 'remote-page-1'
    })

    expect(store.getState().remoteBrowserPageHandlesByPageId).toEqual({})
  })

  it('seeds nothing for a page persisted without a remote page id', () => {
    const store = createHydratedStore({ id: 'page-1', browserRuntimeEnvironmentId: 'env-1' })

    expect(store.getState().remoteBrowserPageHandlesByPageId).toEqual({})
  })

  it('seeds nothing for a client-local page that carries no runtime environment', () => {
    const store = createHydratedStore({ id: 'page-1', remoteBrowserPageId: 'remote-page-1' })

    expect(store.getState().remoteBrowserPageHandlesByPageId).toEqual({})
  })

  // Why this drives the real session object: what a seeded handle does to a pane is decided inside
  // ensureRemotePage. Asserting the store map alone says nothing about which branch it picks.
  function createStreamedSession(
    store: ReturnType<typeof createTestStore>,
    deps: {
      callRpc: RemoteBrowserPageSessionDeps['callRpc']
      currentUrl: string
      closeMissingRemotePage?: (remotePageId: string | null) => void
    }
  ): RemoteBrowserPageSession {
    let remotePage: string | null = null
    return new RemoteBrowserPageSession({
      tokens: {
        isCurrent: () => true,
        get remotePage() {
          return remotePage
        },
        setRemotePage: (value: string | null) => {
          remotePage = value
        }
      } as never,
      callRpc: deps.callRpc,
      getWorktreeSelector: () => WT,
      getCurrentUrl: () => deps.currentUrl,
      readStoredHandle: () => store.getState().remoteBrowserPageHandlesByPageId['page-1'] ?? null,
      writeStoredHandle: (handle) => store.getState().setRemoteBrowserPageHandle('page-1', handle),
      removeStoredHandle: (remotePageId) =>
        store.getState().removeRemoteBrowserPageHandle('page-1', remotePageId),
      applyTabInfo: () => {},
      closeMissingRemotePage: deps.closeMissingRemotePage ?? (() => {})
    })
  }

  it('adopts a remote page this session already created', async () => {
    const store = createHydratedStore({ id: 'page-1', browserRuntimeEnvironmentId: 'env-1' })
    store.getState().setRemoteBrowserPageHandle('page-1', {
      environmentId: 'env-1',
      remotePageId: 'remote-page-1'
    })
    const callRpc = vi.fn(async (_target: unknown, _method: string) => ({
      tab: { url: 'https://example.com/', title: 'Example' }
    }))
    const session = createStreamedSession(store, {
      callRpc: callRpc as never,
      currentUrl: 'https://example.com/'
    })

    const resolved = await session.ensureRemotePage({
      environmentId: 'env-1',
      generation: 1,
      remotePageId: null
    } as never)

    expect(resolved).toBe('remote-page-1')
    expect(callRpc.mock.calls.map(([, method]) => method)).toEqual(['browser.tabShow'])
  })

  // Why the runtime is made to answer browser_tab_not_found: that is what a runtime restarted while
  // the desktop was closed says, and the adopt branch answers it by closing the row. Re-creating is
  // what the user sees as their tab coming back at the URL they left it on.
  it('re-creates a restored server-hosted page at its saved URL instead of adopting it', async () => {
    const store = createHydratedStore({
      id: 'page-1',
      browserRuntimeEnvironmentId: 'env-1',
      remoteBrowserPageId: 'remote-page-1',
      url: 'https://example.com/saved'
    })
    const callRpc = vi.fn(async (_target: unknown, method: string, _params?: unknown) => {
      if (method === 'browser.tabShow') {
        throw new RuntimeRpcCallError({
          ok: false,
          error: { code: 'browser_tab_not_found', message: 'browser_tab_not_found' }
        } as never)
      }
      return { browserPageId: 'remote-page-2' }
    })
    const closeMissingRemotePage = vi.fn()
    const session = createStreamedSession(store, {
      callRpc: callRpc as never,
      currentUrl: 'https://example.com/saved',
      closeMissingRemotePage
    })

    const resolved = await session.ensureRemotePage({
      environmentId: 'env-1',
      generation: 1,
      remotePageId: null
    } as never)

    expect(closeMissingRemotePage).not.toHaveBeenCalled()
    expect(callRpc.mock.calls.map(([, method]) => method)).toEqual(['browser.tabCreate'])
    expect(callRpc.mock.calls[0]?.[2]).toMatchObject({ url: 'https://example.com/saved' })
    expect(resolved).toBe('remote-page-2')
  })
})
