// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  destroyPersistentWebview: vi.fn(),
  getState: vi.fn(),
  profileListener: null as
    | ((data: {
        requestId: string
        browserPageId: string
        profileId: string | null
        sessionPartition: string | null
      }) => void)
    | null,
  replyTabSetProfile: vi.fn(),
  switchBrowserTabProfile: vi.fn()
}))

vi.mock('@/components/browser-pane/host-guest/webview-registry', () => ({
  destroyPersistentWebview: mocks.destroyPersistentWebview
}))
vi.mock('../../store', () => ({
  useAppStore: { getState: mocks.getState }
}))
vi.mock('./browser-automation-bootstrap-lease', () => ({
  acquireBrowserAutomationBootstrapLease: vi.fn()
}))
vi.mock('../../store/pinned-tab-close-guard', () => ({
  guardPinnedTabClose: vi.fn(),
  isUnifiedTabPinned: vi.fn(),
  resolvePinnedTabLabel: vi.fn()
}))

import { registerBrowserRequestIpcBridge } from './browser-request-ipc-bridge'

describe('browser profile request teardown', () => {
  beforeEach(() => {
    mocks.destroyPersistentWebview.mockReset()
    mocks.replyTabSetProfile.mockReset()
    mocks.switchBrowserTabProfile.mockReset()
    mocks.profileListener = null
    mocks.getState.mockReturnValue({
      browserTabsByWorktree: { 'wt-1': [{ id: 'workspace-1' }] },
      browserPagesByWorkspace: {
        'workspace-1': [
          { id: 'page-url', docLocation: null },
          {
            id: 'page-doc',
            docLocation: {
              kind: 'workspace-doc',
              worktreeId: 'wt-1',
              filePath: '/workspace/report.html'
            }
          }
        ]
      },
      switchBrowserTabProfile: mocks.switchBrowserTabProfile
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          onRequestTabCreate: () => () => {},
          replyTabCreate: vi.fn(),
          onRequestTabSetProfile: (listener: typeof mocks.profileListener) => {
            mocks.profileListener = listener
            return () => {}
          },
          replyTabSetProfile: mocks.replyTabSetProfile,
          onRequestTabClose: () => () => {},
          replyTabClose: vi.fn()
        }
      }
    })
  })

  it('keeps document-preview guests while rebuilding URL siblings for a profile change', () => {
    registerBrowserRequestIpcBridge([], () => false)

    mocks.profileListener?.({
      requestId: 'request-1',
      browserPageId: 'page-url',
      profileId: 'profile-2',
      sessionPartition: 'persist:profile-2'
    })

    expect(mocks.destroyPersistentWebview).toHaveBeenCalledExactlyOnceWith('page-url')
    expect(mocks.switchBrowserTabProfile).toHaveBeenCalledWith(
      'workspace-1',
      'profile-2',
      'persist:profile-2'
    )
    expect(mocks.replyTabSetProfile).toHaveBeenCalledWith({ requestId: 'request-1' })
  })
})
