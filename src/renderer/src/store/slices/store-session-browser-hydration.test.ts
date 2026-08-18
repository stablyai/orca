import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
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

createStoreSessionMockApi()

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
