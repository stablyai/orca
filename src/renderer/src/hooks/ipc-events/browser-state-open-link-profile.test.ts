import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createBrowserTabMock, remoteCreateMock, toastErrorMock, runtimeOwnerMock, storeState } =
  vi.hoisted(() => ({
    createBrowserTabMock: vi.fn(),
    remoteCreateMock: vi.fn().mockResolvedValue(true),
    toastErrorMock: vi.fn(),
    runtimeOwnerMock: vi.fn((): string | null => null),
    storeState: {
      value: {} as Record<string, unknown>
    }
  }))

vi.mock('../../store', () => ({
  useAppStore: { getState: () => storeState.value }
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: runtimeOwnerMock
}))
vi.mock('@/components/browser-pane/describe-page/live-browser-url-registry', () => ({
  rememberLiveBrowserUrl: vi.fn()
}))
vi.mock('./browser-automation-bootstrap-lease', () => ({
  acquireBrowserAutomationBootstrapLease: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: remoteCreateMock
}))
import type { BrowserOpenLinkEvent } from '../../../../shared/browser-open-link-event'

import { registerBrowserStateIpcBridge } from './browser-state-ipc-bridge'

const noopUnsubscribe = (): void => {}

function captureOpenLinkHandler(): (event: BrowserOpenLinkEvent) => void {
  let handler: ((event: BrowserOpenLinkEvent) => void) | null = null
  const browserApi = new Proxy(
    {
      onOpenLinkInOrcaTab: (callback: (event: BrowserOpenLinkEvent) => void) => {
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
    remoteCreateMock.mockClear()
    toastErrorMock.mockClear()
    runtimeOwnerMock.mockReturnValue(null)
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

  it('reports a missing legacy profile instead of silently crossing cookie jars', async () => {
    storeState.value = {
      browserPagesByWorkspace: {
        'workspace-1': [{ id: 'page-1', workspaceId: 'missing', worktreeId: 'worktree-1' }]
      },
      browserTabsByWorktree: {},
      createBrowserTab: createBrowserTabMock
    }

    captureOpenLinkHandler()({ browserPageId: 'page-1', url: 'https://docs.example.com/guide' })

    await vi.waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        'The browser link profile is no longer available.'
      )
    )
    expect(createBrowserTabMock).not.toHaveBeenCalled()
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
      activate: false,
      owner: { worktreeId: 'worktree-1', sessionProfileId: null }
    })

    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'worktree-1',
      'https://docs.example.com/background',
      expect.objectContaining({ activate: false })
    )
  })
})

for (const worktreeId of ['repo::/worktree', 'folder:folder-1', 'ssh-repo::/remote/worktree']) {
  it(`uses main owner through a missing renderer projection for ${worktreeId}`, () => {
    runtimeOwnerMock.mockReturnValue(null)
    createBrowserTabMock.mockClear()
    storeState.value = {
      browserPagesByWorkspace: {},
      browserTabsByWorktree: {},
      createBrowserTab: createBrowserTabMock
    }
    captureOpenLinkHandler()({
      browserPageId: 'missing-page',
      childBrowserPageId: 'child',
      url: 'https://example.com/attachment',
      owner: { worktreeId, sessionProfileId: 'isolated-profile' }
    })
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      worktreeId,
      'about:blank',
      expect.objectContaining({ sessionProfileId: 'isolated-profile', browserPageId: 'child' })
    )
  })
}

it('routes a client-hosted remote page through its owning runtime and profile', async () => {
  createBrowserTabMock.mockClear()
  runtimeOwnerMock.mockReturnValue('owning-environment')
  storeState.value = {
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    createBrowserTab: createBrowserTabMock,
    remoteBrowserPageHandlesByPageId: { remote: { placement: { kind: 'client' } } }
  }
  captureOpenLinkHandler()({
    browserPageId: 'remote',
    url: 'https://example.com/attachment',
    owner: { worktreeId: 'folder:remote-folder', sessionProfileId: 'remote-profile' }
  })
  await vi.waitFor(() =>
    expect(remoteCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 'owning-environment',
        worktreeId: 'folder:remote-folder',
        profileId: 'remote-profile',
        placementPreference: 'auto'
      })
    )
  )
  expect(createBrowserTabMock).not.toHaveBeenCalled()
})

it('preserves an explicitly local page when a different runtime owns the workspace projection', () => {
  createBrowserTabMock.mockClear()
  runtimeOwnerMock.mockReturnValue('other-environment')
  storeState.value = {
    browserPagesByWorkspace: {
      workspace: [
        {
          id: 'local-page',
          worktreeId: 'worktree',
          workspaceId: 'workspace',
          browserRuntimeEnvironmentId: null
        }
      ]
    },
    browserTabsByWorktree: {},
    createBrowserTab: createBrowserTabMock
  }
  captureOpenLinkHandler()({
    browserPageId: 'local-page',
    url: 'https://example.com/attachment',
    owner: { worktreeId: 'worktree', sessionProfileId: 'local-profile' }
  })
  expect(createBrowserTabMock).toHaveBeenCalledWith(
    'worktree',
    'https://example.com/attachment',
    expect.objectContaining({ sessionProfileId: 'local-profile' })
  )
})
