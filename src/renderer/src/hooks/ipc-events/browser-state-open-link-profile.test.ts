import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createBrowserTabMock, storeState } = vi.hoisted(() => ({
  createBrowserTabMock: vi.fn(),
  storeState: {
    value: {} as Record<string, unknown>
  }
}))

vi.mock('../../store', () => ({
  useAppStore: { getState: () => storeState.value }
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
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
  ;(globalThis as { window?: unknown }).window = { api }

  registerBrowserStateIpcBridge([], () => false)
  if (!handler) {
    throw new Error('Expected the bridge to subscribe to browser:open-link-in-orca-tab')
  }
  return handler
}

describe('link-opened Orca tabs', () => {
  beforeEach(() => {
    createBrowserTabMock.mockReset()
  })

  it('inherits the opener tab session so an isolated profile cannot leak into the default one', () => {
    storeState.value = {
      browserPagesByWorkspace: {
        'workspace-1': [{ id: 'page-1', workspaceId: 'workspace-1', worktreeId: 'worktree-1' }]
      },
      browserTabsByWorktree: {
        'worktree-1': [
          {
            id: 'workspace-1',
            sessionProfileId: 'profile-client-a',
            sessionPartition: 'persist:orca-browser-session-client-a'
          }
        ]
      },
      createBrowserTab: createBrowserTabMock
    }

    captureOpenLinkHandler()({ browserPageId: 'page-1', url: 'https://docs.example.com/guide' })

    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'worktree-1',
      'https://docs.example.com/guide',
      expect.objectContaining({
        sessionProfileId: 'profile-client-a',
        sessionPartition: 'persist:orca-browser-session-client-a'
      })
    )
  })

  it('leaves the profile unset when the opener tab is gone, so the user default still applies', () => {
    storeState.value = {
      browserPagesByWorkspace: {
        'workspace-1': [{ id: 'page-1', workspaceId: 'missing', worktreeId: 'worktree-1' }]
      },
      browserTabsByWorktree: {},
      createBrowserTab: createBrowserTabMock
    }

    captureOpenLinkHandler()({ browserPageId: 'page-1', url: 'https://docs.example.com/guide' })

    const options = createBrowserTabMock.mock.calls[0][2] as Record<string, unknown>
    expect('sessionProfileId' in options).toBe(false)
  })

  it('creates modifier-click links in the background', () => {
    storeState.value = {
      browserPagesByWorkspace: {
        'workspace-1': [{ id: 'page-1', workspaceId: 'workspace-1', worktreeId: 'worktree-1' }]
      },
      browserTabsByWorktree: {},
      createBrowserTab: createBrowserTabMock
    }

    captureOpenLinkHandler()({
      browserPageId: 'page-1',
      url: 'https://docs.example.com/background',
      activate: false
    })

    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'worktree-1',
      'https://docs.example.com/background',
      expect.objectContaining({ activate: false })
    )
  })

  const focusGroupMock = vi.fn()
  function splitWithVisibleBrowser(): Record<string, unknown> {
    return {
      browserPagesByWorkspace: {
        'workspace-1': [{ id: 'page-1', workspaceId: 'workspace-1', worktreeId: 'worktree-1' }]
      },
      // Opener's profile deliberately differs from the destination browser's: placement is not profile inheritance.
      browserTabsByWorktree: {
        'worktree-1': [
          { id: 'workspace-1', sessionProfileId: 'profile-a', sessionPartition: 'persist:a' }
        ]
      },
      layoutByWorktree: {
        'worktree-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'term' },
          second: { type: 'leaf', groupId: 'web' }
        }
      },
      groupsByWorktree: {
        'worktree-1': [
          { id: 'term', worktreeId: 'worktree-1', activeTabId: 't1', tabOrder: ['t1'] },
          { id: 'web', worktreeId: 'worktree-1', activeTabId: 'b1', tabOrder: ['b1'] }
        ]
      },
      unifiedTabsByWorktree: {
        'worktree-1': [
          { id: 't1', worktreeId: 'worktree-1', groupId: 'term', contentType: 'terminal' },
          { id: 'b1', worktreeId: 'worktree-1', groupId: 'web', contentType: 'browser' }
        ]
      },
      activeGroupIdByWorktree: { 'worktree-1': 'term' },
      focusGroup: focusGroupMock,
      createBrowserTab: createBrowserTabMock
    }
  }

  it('opens the popup in the visible browser group, keeps the opener profile, and focuses it', () => {
    focusGroupMock.mockReset()
    storeState.value = splitWithVisibleBrowser()
    captureOpenLinkHandler()({ browserPageId: 'page-1', url: 'https://docs.example.com/new' })
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'worktree-1',
      'https://docs.example.com/new',
      {
        title: 'https://docs.example.com/new',
        activate: true,
        targetGroupId: 'web',
        sessionProfileId: 'profile-a',
        sessionPartition: 'persist:a'
      }
    )
    expect(focusGroupMock).toHaveBeenCalledWith('worktree-1', 'web')
  })

  it('places a background (activate:false) popup there without moving focus', () => {
    focusGroupMock.mockReset()
    storeState.value = splitWithVisibleBrowser()
    captureOpenLinkHandler()({
      browserPageId: 'page-1',
      url: 'https://x.example/',
      activate: false
    })
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'worktree-1',
      'https://x.example/',
      expect.objectContaining({ activate: false, targetGroupId: 'web' })
    )
    expect(focusGroupMock).not.toHaveBeenCalled()
  })
})
