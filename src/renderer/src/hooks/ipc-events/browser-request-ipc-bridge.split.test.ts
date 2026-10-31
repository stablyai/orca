// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type CreateRequest = {
  requestId: string
  worktreeId?: string
  url: string
  split?: 'right' | 'left' | 'down' | 'up'
  splitFromTabId?: string
}

const mocks = vi.hoisted(() => {
  const listeners: { createListener: ((data: CreateRequest) => void) | null } = {
    createListener: null
  }
  return {
    ...listeners,
    getState: vi.fn(),
    replyTabCreate: vi.fn(),
    createBrowserTab: vi.fn()
  }
})

vi.mock('@/components/browser-pane/host-guest/webview-registry', () => ({
  destroyPersistentWebview: vi.fn()
}))
vi.mock('../../store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('./browser-automation-bootstrap-lease', () => ({
  acquireBrowserAutomationBootstrapLease: vi.fn()
}))

import { registerBrowserRequestIpcBridge } from './browser-request-ipc-bridge'

const WT = 'repo::/Users/me/app'

function storeState() {
  return {
    activeWorktreeId: WT,
    repos: [],
    worktreesByRepo: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    activeGroupIdByWorktree: { [WT]: 'g-active' },
    groupsByWorktree: { [WT]: [{ id: 'g-active' }, { id: 'g-terminal' }] },
    unifiedTabsByWorktree: {
      [WT]: [{ id: 'u-term', entityId: 'term-1', groupId: 'g-terminal', contentType: 'terminal' }]
    },
    createBrowserTab: mocks.createBrowserTab.mockReturnValue({ id: 'ws-new' }),
    ensureWorktreeRootGroup: vi.fn(() => 'g-root')
  }
}

describe('browser tab create with a split pane', () => {
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
          onRequestRemoteCliBrowserScope: () => () => {},
          replyRemoteCliBrowserScope: vi.fn(),
          onRequestTabSetProfile: () => () => {},
          replyTabSetProfile: vi.fn(),
          onRequestTabClose: () => () => {},
          replyTabClose: vi.fn()
        }
      }
    })
    mocks.getState.mockReturnValue(storeState())
    registerBrowserRequestIpcBridge([])
  })

  it("opens the tab in a new pane beside the caller's terminal without taking focus", () => {
    mocks.createListener?.({
      requestId: 'r1',
      worktreeId: WT,
      url: 'https://example.com',
      split: 'right',
      splitFromTabId: 'term-1'
    })

    const options = mocks.createBrowserTab.mock.calls[0]?.[2]
    expect(options).toMatchObject({
      split: { sourceGroupId: 'g-terminal', splitDirection: 'right', activate: false },
      activate: false
    })
    expect(options).not.toHaveProperty('targetGroupId')
    expect(mocks.replyTabCreate).toHaveBeenCalledWith({ requestId: 'r1', browserPageId: 'ws-new' })
  })

  it('splits beside the active pane when the caller tab is unknown', () => {
    mocks.createListener?.({
      requestId: 'r2',
      worktreeId: WT,
      url: 'about:blank',
      split: 'down',
      splitFromTabId: 'stale-tab'
    })

    expect(mocks.createBrowserTab.mock.calls[0]?.[2]).toMatchObject({
      split: { sourceGroupId: 'g-active', splitDirection: 'down' }
    })
  })

  it("opens in the caller's workspace when the CLI names none", () => {
    mocks.getState.mockReturnValue({ ...storeState(), activeWorktreeId: 'other-workspace' })

    mocks.createListener?.({
      requestId: 'r4',
      url: 'about:blank',
      split: 'right',
      splitFromTabId: 'term-1'
    })

    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      WT,
      'about:blank',
      expect.objectContaining({ split: expect.objectContaining({ sourceGroupId: 'g-terminal' }) })
    )
  })

  it('adds a plain tab without --split', () => {
    mocks.createListener?.({ requestId: 'r3', worktreeId: WT, url: 'about:blank' })

    expect(mocks.createBrowserTab.mock.calls[0]?.[2]).not.toHaveProperty('split')
  })
})
