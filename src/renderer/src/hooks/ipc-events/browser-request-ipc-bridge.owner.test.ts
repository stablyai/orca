// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type CreateRequest = { requestId: string; worktreeId?: string; url: string }
type CloseRequest = { requestId: string; tabId?: string | null; worktreeId?: string }

const mocks = vi.hoisted(() => {
  const listeners: {
    createListener: ((data: CreateRequest) => void) | null
    closeListener: ((data: CloseRequest) => void) | null
  } = { createListener: null, closeListener: null }
  return {
    ...listeners,
    getState: vi.fn(),
    replyTabCreate: vi.fn(),
    replyTabClose: vi.fn(),
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
    // The Active Server is a paired server; neither request below may read it.
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

  it("refuses to fall back to a paired server's active workspace", () => {
    mocks.getState.mockReturnValue(storeState(REMOTE_WT))

    mocks.createListener?.({ requestId: 'r2', url: 'about:blank' })

    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
    expect(mocks.replyTabCreate).toHaveBeenCalledWith({
      requestId: 'r2',
      error: expect.stringContaining('paired server')
    })
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
