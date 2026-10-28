// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type CreateRequest = {
  requestId: string
  worktreeId?: string
  url: string
  browserPageId?: string
}
type CloseRequest = { requestId: string; tabId?: string | null; worktreeId?: string }
type ScopeRequest = {
  requestId: string
  environmentId: string
  workspaceId?: string
  pageId?: string
}

const mocks = vi.hoisted(() => {
  const listeners: {
    createListener: ((data: CreateRequest) => void) | null
    closeListener: ((data: CloseRequest) => void) | null
    scopeListener: ((data: ScopeRequest) => void) | null
  } = { createListener: null, closeListener: null, scopeListener: null }
  return {
    ...listeners,
    getState: vi.fn(),
    replyTabCreate: vi.fn(),
    replyTabClose: vi.fn(),
    replyRemoteCliBrowserScope: vi.fn(),
    createBrowserTab: vi.fn(),
    closeBrowserTab: vi.fn()
  }
})

vi.mock('@/components/browser-pane/host-guest/webview-registry', () => ({
  destroyPersistentWebview: vi.fn()
}))
vi.mock('../../store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('./browser-automation-bootstrap-lease', () => ({
  acquireBrowserAutomationBootstrapLease: vi.fn()
}))
vi.mock('../../store/pinned-tab-close-guard', () => ({
  guardPinnedTabClose: ({ onClose }: { onClose: () => void }) => onClose(),
  isUnifiedTabPinned: vi.fn(() => false),
  resolvePinnedTabLabel: vi.fn()
}))

import { registerBrowserRequestIpcBridge } from './browser-request-ipc-bridge'

const LOCAL_WT = 'repo-local::/Users/me/app'
const REMOTE_WT = 'repo-remote::/srv/app'

function storeState(activeWorktreeId: string) {
  return {
    settings: { activeRuntimeEnvironmentId: 'env-remote' },
    activeWorktreeId,
    repos: [
      { id: 'repo-local', executionHostId: 'local' },
      { id: 'repo-remote', executionHostId: 'runtime:env-remote' }
    ],
    worktreesByRepo: {
      'repo-local': [{ id: LOCAL_WT, repoId: 'repo-local', hostId: 'local' }],
      'repo-remote': [
        {
          id: REMOTE_WT,
          repoId: 'repo-remote',
          hostId: 'runtime:env-remote',
          runtimeOwnerEnvironmentId: 'env-remote'
        }
      ]
    },
    browserTabsByWorktree: {
      [LOCAL_WT]: [{ id: 'ws-local' }],
      [REMOTE_WT]: [{ id: 'ws-remote' }]
    },
    browserPagesByWorkspace: {
      'ws-local': [{ id: 'page-local' }],
      'ws-remote': [{ id: 'page-remote' }]
    },
    activeBrowserTabIdByWorktree: {},
    unifiedTabsByWorktree: {},
    createBrowserTab: mocks.createBrowserTab.mockImplementation(() => ({ id: 'ws-new' })),
    closeBrowserTab: mocks.closeBrowserTab,
    closeBrowserPage: vi.fn()
  }
}

describe('browser requests from this desktop follow the workspace owner (#22275)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          onRequestTabCreate: (listener: typeof mocks.createListener) => {
            mocks.createListener = listener
            return () => {}
          },
          replyTabCreate: mocks.replyTabCreate,
          onRequestRemoteCliBrowserScope: (listener: typeof mocks.scopeListener) => {
            mocks.scopeListener = listener
            return () => {}
          },
          replyRemoteCliBrowserScope: mocks.replyRemoteCliBrowserScope,
          onRequestTabSetProfile: () => () => {},
          replyTabSetProfile: vi.fn(),
          onRequestTabClose: (listener: typeof mocks.closeListener) => {
            mocks.closeListener = listener
            return () => {}
          },
          replyTabClose: mocks.replyTabClose
        }
      }
    })
    registerBrowserRequestIpcBridge([])
  })

  it('creates a tab for an explicit local worktree while a paired server is the Active Server', () => {
    mocks.getState.mockReturnValue(storeState(REMOTE_WT))

    mocks.createListener?.({ requestId: 'r1', worktreeId: LOCAL_WT, url: 'about:blank' })

    expect(mocks.createBrowserTab).toHaveBeenCalledWith(LOCAL_WT, 'about:blank', expect.anything())
    expect(mocks.replyTabCreate).toHaveBeenCalledWith({ requestId: 'r1', browserPageId: 'ws-new' })
  })

  it("answers with the new tab's page before main's frame draws it (layout-owner build)", () => {
    mocks.getState.mockReturnValue(storeState(LOCAL_WT))
    mocks.createBrowserTab.mockImplementation(() => ({ id: 'ws-new', activePageId: 'page-new' }))

    mocks.createListener?.({ requestId: 'r4', worktreeId: LOCAL_WT, url: 'about:blank' })

    // Not the workspace id: a paired client matches the reply against the page it asked for.
    expect(mocks.replyTabCreate).toHaveBeenCalledWith({
      requestId: 'r4',
      browserPageId: 'page-new'
    })

    mocks.createListener?.({
      requestId: 'r5',
      worktreeId: LOCAL_WT,
      url: 'about:blank',
      browserPageId: 'page-asked'
    })

    expect(mocks.replyTabCreate).toHaveBeenCalledWith({
      requestId: 'r5',
      browserPageId: 'page-asked'
    })
  })

  it("renders a page named in a managed host's workspace on this desktop (#29145)", () => {
    mocks.getState.mockReturnValue(storeState(LOCAL_WT))

    mocks.createListener?.({ requestId: 'r3', worktreeId: REMOTE_WT, url: 'https://a.test' })

    // A missing runtime id would be inferred from the workspace and stream the server's page instead.
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      REMOTE_WT,
      'https://a.test',
      expect.objectContaining({ browserRuntimeEnvironmentId: null })
    )
  })

  it("refuses to fall back to a paired server's active workspace", () => {
    mocks.getState.mockReturnValue(storeState(REMOTE_WT))

    mocks.createListener?.({ requestId: 'r2', url: 'about:blank' })

    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
    expect(mocks.replyTabCreate).toHaveBeenCalledWith({
      requestId: 'r2',
      error: expect.stringContaining('paired server')
    })
  })

  it("closes a desktop-rendered tab in a managed host's workspace (#29145)", () => {
    const state = storeState(LOCAL_WT)
    mocks.getState.mockReturnValue({
      ...state,
      browserPagesByWorkspace: {
        ...state.browserPagesByWorkspace,
        'ws-remote': [{ id: 'page-remote', browserRuntimeEnvironmentId: null }]
      }
    })

    mocks.closeListener?.({ requestId: 'c3', tabId: 'page-remote', worktreeId: REMOTE_WT })

    expect(mocks.closeBrowserTab).toHaveBeenCalledExactlyOnceWith('ws-remote')
    expect(mocks.replyTabClose).toHaveBeenCalledWith({ requestId: 'c3' })
  })

  it("closes a local page but refuses a paired server's page", () => {
    mocks.getState.mockReturnValue(storeState(LOCAL_WT))

    mocks.closeListener?.({ requestId: 'c1', tabId: 'ws-local', worktreeId: LOCAL_WT })
    mocks.closeListener?.({ requestId: 'c2', tabId: 'page-remote' })

    expect(mocks.closeBrowserTab).toHaveBeenCalledExactlyOnceWith('ws-local')
    expect(mocks.replyTabClose).toHaveBeenCalledWith({ requestId: 'c1' })
    expect(mocks.replyTabClose).toHaveBeenCalledWith({
      requestId: 'c2',
      error: expect.stringContaining('paired server')
    })
  })
})

describe('a managed SSH host reaches only its own workspaces on this desktop (#29145)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          onRequestTabCreate: () => () => {},
          replyTabCreate: vi.fn(),
          onRequestRemoteCliBrowserScope: (listener: typeof mocks.scopeListener) => {
            mocks.scopeListener = listener
            return () => {}
          },
          replyRemoteCliBrowserScope: mocks.replyRemoteCliBrowserScope,
          onRequestTabSetProfile: () => () => {},
          replyTabSetProfile: vi.fn(),
          onRequestTabClose: () => () => {},
          replyTabClose: vi.fn()
        }
      }
    })
    registerBrowserRequestIpcBridge([])
  })

  it('allows the owning environment and refuses every other one and local workspaces', () => {
    mocks.getState.mockReturnValue(storeState(LOCAL_WT))

    mocks.scopeListener?.({ requestId: 's1', environmentId: 'env-remote', workspaceId: REMOTE_WT })
    mocks.scopeListener?.({ requestId: 's2', environmentId: 'env-other', workspaceId: REMOTE_WT })
    mocks.scopeListener?.({ requestId: 's3', environmentId: 'env-remote', workspaceId: LOCAL_WT })
    mocks.scopeListener?.({ requestId: 's4', environmentId: 'env-remote', workspaceId: 'nope::/x' })

    expect(mocks.replyRemoteCliBrowserScope.mock.calls.map(([reply]) => reply)).toEqual([
      { requestId: 's1', workspaceId: REMOTE_WT },
      { requestId: 's2', workspaceId: null },
      { requestId: 's3', workspaceId: null },
      { requestId: 's4', workspaceId: null }
    ])
  })

  it('resolves a page to its workspace, and refuses a page of another workspace', () => {
    mocks.getState.mockReturnValue(storeState(LOCAL_WT))

    mocks.scopeListener?.({ requestId: 'p1', environmentId: 'env-remote', pageId: 'page-remote' })
    mocks.scopeListener?.({ requestId: 'p2', environmentId: 'env-remote', pageId: 'page-local' })
    mocks.scopeListener?.({
      requestId: 'p3',
      environmentId: 'env-remote',
      pageId: 'page-local',
      workspaceId: REMOTE_WT
    })
    mocks.scopeListener?.({ requestId: 'p4', environmentId: 'env-remote', pageId: 'missing' })

    expect(mocks.replyRemoteCliBrowserScope.mock.calls.map(([reply]) => reply)).toEqual([
      { requestId: 'p1', workspaceId: REMOTE_WT },
      { requestId: 'p2', workspaceId: null },
      { requestId: 'p3', workspaceId: null },
      { requestId: 'p4', workspaceId: null }
    ])
  })

  it('answers no when the store cannot resolve the owner', () => {
    mocks.getState.mockImplementation(() => {
      throw new Error('store unavailable')
    })

    mocks.scopeListener?.({ requestId: 's5', environmentId: 'env-remote', workspaceId: REMOTE_WT })

    expect(mocks.replyRemoteCliBrowserScope).toHaveBeenCalledWith({
      requestId: 's5',
      workspaceId: null
    })
  })
})
