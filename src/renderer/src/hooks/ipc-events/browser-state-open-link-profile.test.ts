import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createBrowserTabMock, dispatchEventMock, storeState } = vi.hoisted(() => ({
  createBrowserTabMock: vi.fn(),
  dispatchEventMock: vi.fn(),
  storeState: {
    value: {} as Record<string, unknown>
  }
}))

vi.mock('../../store', () => ({
  useAppStore: { getState: () => storeState.value }
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
}))
vi.mock('@/components/browser-pane/describe-page/live-browser-url-registry', () => ({
  rememberLiveBrowserUrl: vi.fn()
}))
vi.mock('./browser-automation-bootstrap-lease', () => ({
  acquireBrowserAutomationBootstrapLease: vi.fn()
}))

import { registerBrowserStateIpcBridge } from './browser-state-ipc-bridge'

const noopUnsubscribe = (): void => {}

function captureOpenLinkHandler(): (event: {
  browserPageId: string
  url: string
  activate?: boolean
}) => void {
  let handler:
    | ((event: { browserPageId: string; url: string; activate?: boolean }) => void)
    | null = null
  const browserApi = new Proxy(
    {
      onOpenLinkInOrcaTab: (
        callback: (event: { browserPageId: string; url: string; activate?: boolean }) => void
      ) => {
        handler = callback
        return noopUnsubscribe
      }
    } as Record<string, unknown>,
    {
      get: (target, property) =>
        property in target ? target[property as string] : () => noopUnsubscribe
    }
  )
  const api = new Proxy({ browser: browserApi } as Record<string, unknown>, {
    get: (target, property) =>
      property in target
        ? target[property as string]
        : new Proxy({}, { get: () => () => noopUnsubscribe })
  })
  vi.stubGlobal('window', { api, dispatchEvent: dispatchEventMock })

  registerBrowserStateIpcBridge([], () => false)
  if (!handler) {
    throw new Error('Expected the bridge to subscribe to browser:open-link-in-orca-tab')
  }
  return handler
}

describe('link-opened Orca tabs', () => {
  beforeEach(() => {
    createBrowserTabMock.mockReset()
    dispatchEventMock.mockReset()
    createBrowserTabMock.mockReturnValue({ id: 'new-tab', activePageId: 'new-page' })
  })
  it.each([true, false])(
    'routes a popup to a visible browser with the opener profile (activate: %s)',
    (activate) => {
      const focusGroup = vi.fn()
      storeState.value = {
        browserPagesByWorkspace: {
          opener: [{ id: 'page-1', workspaceId: 'opener', worktreeId: 'worktree-1' }]
        },
        browserTabsByWorktree: {
          'worktree-1': [
            { id: 'opener', sessionProfileId: 'profile-a', sessionPartition: 'persist:a' }
          ]
        },
        layoutByWorktree: {
          'worktree-1': {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'source' },
            second: { type: 'leaf', groupId: 'visible' }
          }
        },
        groupsByWorktree: {
          'worktree-1': [
            { id: 'source', activeTabId: 'terminal' },
            { id: 'visible', activeTabId: 'browser' }
          ]
        },
        unifiedTabsByWorktree: {
          'worktree-1': [{ id: 'browser', groupId: 'visible', contentType: 'browser' }]
        },
        activeGroupIdByWorktree: { 'worktree-1': 'source' },
        createBrowserTab: createBrowserTabMock,
        focusGroup
      }
      captureOpenLinkHandler()({
        browserPageId: 'page-1',
        url: 'https://docs.example.com/new',
        activate
      })
      expect(createBrowserTabMock).toHaveBeenCalledWith(
        'worktree-1',
        'https://docs.example.com/new',
        expect.objectContaining({
          activate,
          targetGroupId: 'visible',
          sessionProfileId: 'profile-a',
          sessionPartition: 'persist:a'
        })
      )
      if (activate) {
        expect(focusGroup).toHaveBeenCalledExactlyOnceWith('worktree-1', 'visible')
      } else {
        expect(focusGroup).not.toHaveBeenCalled()
        expect(dispatchEventMock).not.toHaveBeenCalled()
      }
    }
  )
})
