import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createBrowserTabMock,
  createWebRuntimeSessionBrowserTabMock,
  dispatchEventMock,
  runtimeOwner,
  storeState
} = vi.hoisted(() => ({
  createBrowserTabMock: vi.fn(),
  createWebRuntimeSessionBrowserTabMock: vi.fn(),
  dispatchEventMock: vi.fn(),
  runtimeOwner: { value: null as string | null },
  storeState: { value: {} as Record<string, unknown> }
}))

vi.mock('../../store', () => ({
  useAppStore: { getState: () => storeState.value }
}))
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => storeState.value }
}))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => runtimeOwner.value
}))
vi.mock('@/runtime/browser/creation/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: createWebRuntimeSessionBrowserTabMock
}))
vi.mock('@/lib/client-creation-action-error', () => ({
  showClientCreationActionError: vi.fn()
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

function clientHostedStore(handle: Record<string, unknown>): void {
  storeState.value = {
    browserPagesByWorkspace: {
      opener: [
        {
          id: 'page-1',
          workspaceId: 'opener',
          worktreeId: 'worktree-1'
        }
      ]
    },
    browserTabsByWorktree: {
      'worktree-1': [{ id: 'opener', sessionProfileId: 'profile-a', sessionPartition: 'persist:a' }]
    },
    unifiedTabsByWorktree: {
      'worktree-1': [
        { id: 'unified-browser', groupId: 'source', contentType: 'browser', entityId: 'opener' }
      ]
    },
    groupsByWorktree: {
      'worktree-1': [{ id: 'source', tabOrder: ['unified-browser'] }]
    },
    remoteBrowserPageHandlesByPageId: { 'page-1': handle },
    createBrowserTab: createBrowserTabMock,
    focusGroup: vi.fn()
  }
}

describe('client-hosted link opens on a paired server', () => {
  beforeEach(() => {
    createBrowserTabMock.mockReset()
    createWebRuntimeSessionBrowserTabMock.mockReset()
    createWebRuntimeSessionBrowserTabMock.mockResolvedValue(true)
    dispatchEventMock.mockReset()
    runtimeOwner.value = 'env-paired'
  })

  it('opens a This device page link through the paired creator instead of dropping it', () => {
    clientHostedStore({
      environmentId: 'env-paired',
      remotePageId: 'remote-1',
      placement: { kind: 'client', browserHostClientId: 'this-desktop' }
    })
    captureOpenLinkHandler()({
      browserPageId: 'page-1',
      url: 'https://docs.example.com/next',
      activate: true
    })
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(createWebRuntimeSessionBrowserTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'worktree-1',
        environmentId: 'env-paired',
        url: 'https://docs.example.com/next',
        profileId: 'profile-a',
        clientAfterTabId: 'unified-browser',
        focusOnCreate: true,
        selectWorktree: false
      })
    )
    expect(createWebRuntimeSessionBrowserTabMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'placementPreference'
    )
  })

  it('still drops a streamed remote page instead of creating a local tab', () => {
    clientHostedStore({
      environmentId: 'env-paired',
      remotePageId: 'remote-1',
      placement: { kind: 'server' }
    })
    captureOpenLinkHandler()({
      browserPageId: 'page-1',
      url: 'https://docs.example.com/streamed'
    })
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(createWebRuntimeSessionBrowserTabMock).not.toHaveBeenCalled()
  })
})
