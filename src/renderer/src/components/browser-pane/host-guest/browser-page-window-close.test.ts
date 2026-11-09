import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dispatchMock, closeBrowserPageMock, storeState } = vi.hoisted(() => {
  const value: Record<string, unknown> = {}
  return { dispatchMock: vi.fn(), closeBrowserPageMock: vi.fn(), storeState: { value } }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState.value } }))
vi.mock('@/lib/workspace/tabs/workspace-tab-commands', () => ({
  dispatchWorkspaceTabCommand: dispatchMock
}))
import { handleGuestWindowCloseMessage } from './browser-page-window-close'
import { BROWSER_GUEST_WINDOW_CLOSE_CHANNEL } from '../../../../../shared/browser-guest-window-close'

function seedTab(pageId: string, isPinned = false, siblingPageIds: string[] = []): void {
  storeState.value = {
    closeBrowserPage: closeBrowserPageMock,
    browserTabsByWorktree: { 'wt-1': [{ id: 'ws-1' }] },
    browserPagesByWorkspace: { 'ws-1': [{ id: pageId }, ...siblingPageIds.map((id) => ({ id }))] },
    unifiedTabsByWorktree: {
      'wt-1': [{ id: 'tab-1', contentType: 'browser', entityId: 'ws-1', isPinned }]
    }
  }
}

function closeFrom(pageId: string, history: { back: boolean; forward: boolean }): void {
  const webview = { canGoBack: () => history.back, canGoForward: () => history.forward }
  handleGuestWindowCloseMessage(pageId, webview, { channel: BROWSER_GUEST_WINDOW_CLOSE_CHANNEL })
}

describe('window.close() from a browser page', () => {
  beforeEach(() => {
    dispatchMock.mockReset()
    closeBrowserPageMock.mockReset()
  })

  it('never closes a pinned tab', () => {
    seedTab('page-d', true)
    closeFrom('page-d', { back: false, forward: false })
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('closes only the calling page when its Orca tab holds other pages', () => {
    seedTab('page-e', false, ['page-sibling'])
    closeFrom('page-e', { back: false, forward: false })
    expect(closeBrowserPageMock).toHaveBeenCalledWith('page-e')
    expect(dispatchMock).not.toHaveBeenCalled()
  })
})
