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

function captureOpenLinkHandler(): (event: { browserPageId: string; url: string }) => void {
  let handler: ((event: { browserPageId: string; url: string }) => void) | null = null
  const browserApi = new Proxy(
    {
      onOpenLinkInOrcaTab: (callback: (event: { browserPageId: string; url: string }) => void) => {
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
})
