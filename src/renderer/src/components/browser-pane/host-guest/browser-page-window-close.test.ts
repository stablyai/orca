import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dispatchMock, closeBrowserPageMock, storeState } = vi.hoisted(() => {
  const value: Record<string, unknown> = {}
  return { dispatchMock: vi.fn(), closeBrowserPageMock: vi.fn(), storeState: { value } }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState.value } }))
vi.mock('@/lib/workspace-tab-commands', () => ({ dispatchWorkspaceTabCommand: dispatchMock }))

import {
  handleGuestWindowCloseMessage,
  markBrowserPageOpenedByPage
} from './browser-page-window-close'
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

  it('closes a tab with a single history entry through the Cmd/Ctrl+W command', () => {
    seedTab('page-a')
    closeFrom('page-a', { back: false, forward: false })
    expect(dispatchMock).toHaveBeenCalledWith({
      type: 'close',
      target: { kind: 'tab', worktreeId: 'wt-1', tabId: 'tab-1' }
    })
  })

  it('ignores a page the user navigated in that no page opened, like Chrome', () => {
    seedTab('page-b')
    closeFrom('page-b', { back: true, forward: false })
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('closes a page-opened tab even after it navigated', () => {
    seedTab('page-c')
    markBrowserPageOpenedByPage('page-c')
    closeFrom('page-c', { back: true, forward: false })
    expect(dispatchMock).toHaveBeenCalledTimes(1)
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
