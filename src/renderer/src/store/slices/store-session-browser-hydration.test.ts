import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'
import '../../../../shared/constants'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  RemoteBrowserPageSession,
  type RemoteBrowserPageSessionDeps
} from '@/components/browser-pane/stream-remote/remote-browser-page-session'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { resetRestoredBrowserClientHostAttachForTests } from '@/runtime/restored-client-hosted-browser-host-attach'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { createStoreSessionMockApi, makeBrowserTab } from './store-session-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

createStoreSessionMockApi()

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

  // Drive ensureRemotePage through the real session; store-map assertions alone cannot prove adopt versus create.
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

  // Restarted runtime returns browser_tab_not_found; recreate at saved URL instead of adopting and deleting the row.
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
      tabId: 'page-1',
      environmentId: 'env-1',
      generation: 1,
      remotePageId: null
    })

    expect(closeMissingRemotePage).not.toHaveBeenCalled()
    // Switch-on first probes the row id with tabShow; the restarted runtime has no such page.
    expect(callRpc.mock.calls.map(([, method]) => method)).toEqual(
      ORCA_LAYOUT_OWNER_IS_MAIN ? ['browser.tabShow', 'browser.tabCreate'] : ['browser.tabCreate']
    )
    expect(callRpc.mock.calls.at(-1)?.[2]).toMatchObject({ url: 'https://example.com/saved' })
    expect(resolved).toBe('remote-page-2')
  })
})
