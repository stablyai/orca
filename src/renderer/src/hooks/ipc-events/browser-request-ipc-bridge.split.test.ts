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
    createBrowserTab: vi.fn(),
    createEmptySplitGroup: vi.fn(),
    closeEmptyGroup: vi.fn()
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
    createBrowserTab: mocks.createBrowserTab,
    createEmptySplitGroup: mocks.createEmptySplitGroup.mockReturnValue('g-split'),
    ensureWorktreeRootGroup: vi.fn(() => 'g-active'),
    closeEmptyGroup: mocks.closeEmptyGroup
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

  it("puts the tab in a new pane beside the caller's terminal", () => {
    mocks.createBrowserTab.mockReturnValue({ id: 'ws-new' })

    mocks.createListener?.({
      requestId: 'r1',
      worktreeId: WT,
      url: 'https://example.com',
      split: 'right',
      splitFromTabId: 'term-1'
    })

    expect(mocks.createEmptySplitGroup).toHaveBeenCalledWith(WT, 'g-terminal', 'right', {
      activate: false
    })
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(
      WT,
      'https://example.com',
      expect.objectContaining({ targetGroupId: 'g-split' })
    )
    expect(mocks.replyTabCreate).toHaveBeenCalledWith({ requestId: 'r1', browserPageId: 'ws-new' })
  })

  it('leaves the layout alone without --split', () => {
    mocks.createBrowserTab.mockReturnValue({ id: 'ws-new' })

    mocks.createListener?.({ requestId: 'r2', worktreeId: WT, url: 'about:blank' })

    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
  })

  it('removes the empty pane when the tab cannot be created', () => {
    mocks.createBrowserTab.mockImplementation(() => {
      throw new Error('Browser page page-1 already exists')
    })

    mocks.createListener?.({ requestId: 'r3', worktreeId: WT, url: 'about:blank', split: 'down' })

    expect(mocks.closeEmptyGroup).toHaveBeenCalledWith(WT, 'g-split')
    expect(mocks.replyTabCreate).toHaveBeenCalledWith({
      requestId: 'r3',
      error: 'Browser page page-1 already exists'
    })
  })
})
