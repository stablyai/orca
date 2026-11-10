import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createBrowserTabMock, createWebRuntimeSessionBrowserTabMock, runtimeOwner, storeState } =
  vi.hoisted(() => ({
    createBrowserTabMock: vi.fn(),
    createWebRuntimeSessionBrowserTabMock: vi.fn(),
    runtimeOwner: { value: null as string | null },
    storeState: { value: {} as Record<string, unknown> }
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

import { openLinkInNewBrowserTab } from './open-client-hosted-link-beside-page'

describe('openLinkInNewBrowserTab', () => {
  beforeEach(() => {
    createBrowserTabMock.mockReset()
    createBrowserTabMock.mockReturnValue({ id: 'new-tab', activePageId: null })
    createWebRuntimeSessionBrowserTabMock.mockReset()
    createWebRuntimeSessionBrowserTabMock.mockResolvedValue(true)
    runtimeOwner.value = null
  })

  it('opens a restored This device page in the background through the paired creator', () => {
    runtimeOwner.value = 'env-paired'
    storeState.value = {
      browserPagesByWorkspace: {
        opener: [{ id: 'page-1', workspaceId: 'opener', worktreeId: 'worktree-1' }]
      },
      browserTabsByWorktree: {
        'worktree-1': [{ id: 'opener', sessionProfileId: 'profile-a' }]
      },
      unifiedTabsByWorktree: {
        'worktree-1': [
          { id: 'unified-browser', groupId: 'source', contentType: 'browser', entityId: 'opener' }
        ]
      },
      groupsByWorktree: {
        'worktree-1': [{ id: 'source', tabOrder: ['unified-browser'] }]
      },
      remoteBrowserPageHandlesByPageId: {
        'page-1': {
          environmentId: 'env-paired',
          remotePageId: 'remote-1',
          restoredClientHosted: true
        }
      },
      createBrowserTab: createBrowserTabMock
    }
    openLinkInNewBrowserTab({
      sourcePageId: 'page-1',
      worktreeId: 'worktree-1',
      url: 'https://docs.example.com/menu',
      activate: false
    })
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(createWebRuntimeSessionBrowserTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'worktree-1',
        environmentId: 'env-paired',
        url: 'https://docs.example.com/menu',
        profileId: 'profile-a',
        clientAfterTabId: 'unified-browser',
        focusOnCreate: false,
        selectWorktree: false
      })
    )
    expect(createWebRuntimeSessionBrowserTabMock.mock.calls[0]?.[0]).not.toHaveProperty(
      'placementPreference'
    )
  })

  it('keeps a local page on createBrowserTab', () => {
    storeState.value = {
      browserPagesByWorkspace: {
        opener: [{ id: 'page-1', workspaceId: 'opener', worktreeId: 'worktree-1' }]
      },
      browserTabsByWorktree: {
        'worktree-1': [{ id: 'opener', sessionProfileId: 'profile-a' }]
      },
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      remoteBrowserPageHandlesByPageId: {},
      createBrowserTab: createBrowserTabMock
    }
    openLinkInNewBrowserTab({
      sourcePageId: 'page-1',
      worktreeId: 'worktree-1',
      url: 'https://docs.example.com/local',
      activate: false
    })
    expect(createWebRuntimeSessionBrowserTabMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'worktree-1',
      'https://docs.example.com/local',
      expect.objectContaining({
        activate: false,
        sessionProfileId: 'profile-a'
      })
    )
  })
})
