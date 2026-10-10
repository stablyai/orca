import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, closeWorkspaceBrowserTabMock, getRuntimeEnvironmentIdMock } = vi.hoisted(
  () => ({
    getStateMock: vi.fn(),
    closeWorkspaceBrowserTabMock: vi.fn(),
    getRuntimeEnvironmentIdMock: vi.fn()
  })
)

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('./workspace-browser-tab-close', () => ({
  closeWorkspaceBrowserTab: closeWorkspaceBrowserTabMock
}))
vi.mock('./worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: getRuntimeEnvironmentIdMock
}))

import { closeBrowserPageFromGuest } from './browser-page-guest-close'

function makeState({
  pageIds = ['page-1'],
  isPinned = false
}: { pageIds?: string[]; isPinned?: boolean } = {}) {
  return {
    browserTabsByWorktree: { 'wt-1': [{ id: 'workspace-1' }] },
    browserPagesByWorkspace: {
      'workspace-1': pageIds.map((id) => ({ id, workspaceId: 'workspace-1', worktreeId: 'wt-1' }))
    },
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          entityId: 'workspace-1',
          contentType: 'browser',
          groupId: 'group-1',
          isPinned
        }
      ]
    },
    groupsByWorktree: { 'wt-1': [{ id: 'group-1', tabOrder: ['tab-1'] }] },
    closeBrowserPage: vi.fn()
  }
}

describe('closeBrowserPageFromGuest', () => {
  beforeEach(() => {
    getStateMock.mockReset()
    closeWorkspaceBrowserTabMock.mockReset()
    getRuntimeEnvironmentIdMock.mockReset().mockReturnValue(null)
  })

  it('closes the tab through the user close path when the page is its only page', () => {
    getStateMock.mockReturnValue(makeState())

    closeBrowserPageFromGuest('page-1')

    expect(closeWorkspaceBrowserTabMock).toHaveBeenCalledWith('wt-1', 'workspace-1', 'tab-1')
  })

  it('closes only the requesting page when its tab holds other pages', () => {
    const state = makeState({ pageIds: ['page-1', 'page-2'] })
    getStateMock.mockReturnValue(state)

    closeBrowserPageFromGuest('page-2')

    expect(state.closeBrowserPage).toHaveBeenCalledWith('page-2')
    expect(closeWorkspaceBrowserTabMock).not.toHaveBeenCalled()
  })

  it('keeps a pinned tab open', () => {
    getStateMock.mockReturnValue(makeState({ isPinned: true }))

    closeBrowserPageFromGuest('page-1')

    expect(closeWorkspaceBrowserTabMock).not.toHaveBeenCalled()
  })

  it('ignores pages hosted by a remote runtime and pages that are already gone', () => {
    const state = makeState()
    getStateMock.mockReturnValue(state)
    getRuntimeEnvironmentIdMock.mockReturnValue('env-1')

    closeBrowserPageFromGuest('page-1')
    getRuntimeEnvironmentIdMock.mockReturnValue(null)
    closeBrowserPageFromGuest('page-missing')

    expect(closeWorkspaceBrowserTabMock).not.toHaveBeenCalled()
    expect(state.closeBrowserPage).not.toHaveBeenCalled()
  })
})
