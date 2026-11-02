// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type CreateRequest = {
  requestId: string
  worktreeId?: string
  url: string
  fallbackWorktreeId?: string
}

const mocks = vi.hoisted(() => {
  const listeners: { createListener: ((data: CreateRequest) => void) | null } = {
    createListener: null
  }
  return {
    ...listeners,
    getState: vi.fn(),
    subscribe: vi.fn(),
    replyTabCreate: vi.fn(),
    createBrowserTab: vi.fn(),
    browserTabRequestsReady: vi.fn()
  }
})

vi.mock('@/components/browser-pane/host-guest/webview-registry', () => ({
  destroyPersistentWebview: vi.fn()
}))
vi.mock('../../store', () => ({
  useAppStore: { getState: mocks.getState, subscribe: mocks.subscribe }
}))
vi.mock('./browser-automation-bootstrap-lease', () => ({
  acquireBrowserAutomationBootstrapLease: vi.fn()
}))

import {
  registerBrowserRequestIpcBridge,
  signalBrowserTabRequestsReadyAfterRestore
} from './browser-request-ipc-bridge'

const ACTIVE_WT = 'repo-local::/Users/me/app'
const RECENT_WT = 'repo-local::/Users/me/app-2'
const REMOTE_WT = 'repo-remote::/srv/app'

function storeState(activeWorktreeId: string | null) {
  const worktreesByRepo = {
    'repo-local': [
      { id: ACTIVE_WT, repoId: 'repo-local', hostId: 'local' },
      { id: RECENT_WT, repoId: 'repo-local', hostId: 'local' }
    ],
    'repo-remote': [
      {
        id: REMOTE_WT,
        repoId: 'repo-remote',
        hostId: 'runtime:env-remote',
        runtimeOwnerEnvironmentId: 'env-remote'
      }
    ]
  }
  return {
    settings: {},
    workspaceSessionReady: true,
    activeWorktreeId,
    repos: [
      { id: 'repo-local', executionHostId: 'local' },
      { id: 'repo-remote', executionHostId: 'runtime:env-remote' }
    ],
    worktreesByRepo,
    getKnownWorktreeById: (id: string) =>
      Object.values(worktreesByRepo)
        .flat()
        .find((worktree) => worktree.id === id),
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    unifiedTabsByWorktree: {},
    createBrowserTab: mocks.createBrowserTab.mockImplementation(() => ({ id: 'ws-new' }))
  }
}

describe('an extension tab with no active workspace', () => {
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
          browserTabRequestsReady: mocks.browserTabRequestsReady,
          onRequestRemoteCliBrowserScope: () => () => {},
          onRequestTabSetProfile: () => () => {},
          onRequestTabClose: () => () => {}
        }
      }
    })
    mocks.getState.mockReturnValue(storeState(null))
    registerBrowserRequestIpcBridge([])
  })

  it('tells main it can take tab requests once workspaces are restored', () => {
    signalBrowserTabRequestsReadyAfterRestore([])
    expect(mocks.browserTabRequestsReady).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()
    const listeners: ((state: { workspaceSessionReady: boolean }) => void)[] = []
    mocks.subscribe.mockImplementation(
      (listener: (state: { workspaceSessionReady: boolean }) => void) => {
        listeners.push(listener)
        return () => {}
      }
    )
    mocks.getState.mockReturnValue({ ...storeState(null), workspaceSessionReady: false })
    signalBrowserTabRequestsReadyAfterRestore([])
    expect(mocks.browserTabRequestsReady).not.toHaveBeenCalled()
    listeners.forEach((listener) => listener({ workspaceSessionReady: true }))
    expect(mocks.browserTabRequestsReady).toHaveBeenCalledTimes(1)
  })

  it("opens in the workspace the profile's tabs were last used in", () => {
    mocks.getState.mockReturnValue(storeState(null))
    mocks.createListener?.({
      requestId: 'r1',
      url: 'https://a.test',
      fallbackWorktreeId: RECENT_WT
    })
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      RECENT_WT,
      'https://a.test',
      expect.anything()
    )
    expect(mocks.replyTabCreate).toHaveBeenCalledWith({ requestId: 'r1', browserPageId: 'ws-new' })
  })

  it('still prefers the active workspace', () => {
    mocks.getState.mockReturnValue(storeState(ACTIVE_WT))
    mocks.createListener?.({
      requestId: 'r2',
      url: 'https://a.test',
      fallbackWorktreeId: RECENT_WT
    })
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      ACTIVE_WT,
      'https://a.test',
      expect.anything()
    )
  })

  it("never falls back into a paired server's workspace", () => {
    mocks.getState.mockReturnValue(storeState(null))
    mocks.createListener?.({
      requestId: 'r5',
      url: 'https://a.test',
      fallbackWorktreeId: REMOTE_WT
    })
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
    expect(mocks.replyTabCreate).toHaveBeenCalledWith({
      requestId: 'r5',
      error: expect.stringContaining('paired server')
    })
  })
})
