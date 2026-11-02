import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state, focusTerminalTabSurface: vi.fn(), requestBrowserFocus: vi.fn() }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.state })
}))
vi.mock('./focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))
vi.mock('@/components/browser-pane/host-guest/browser-focus', () => ({
  requestBrowserFocus: mocks.requestBrowserFocus
}))

import { focusActiveTabSurface } from './focus-active-tab-surface'

describe('focusActiveTabSurface', () => {
  beforeEach(() => {
    mocks.focusTerminalTabSurface.mockClear()
    mocks.requestBrowserFocus.mockClear()
    mocks.state = {
      activeWorktreeId: 'wt',
      activeTabType: 'terminal',
      activeTabId: 'fallback-tab',
      activeTabIdByWorktree: { wt: 'tab-1' },
      terminalLayoutsByTabId: { 'tab-1': { activeLeafId: 'leaf-2' } },
      browserTabsByWorktree: { wt: [{ id: 'b1', activePageId: 'page-9' }] },
      activeBrowserTabId: 'b1'
    }
  })

  it('focuses the active terminal pane', () => {
    focusActiveTabSurface()

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1', 'leaf-2')
  })

  it('focuses the active browser page', () => {
    mocks.state.activeTabType = 'browser'

    focusActiveTabSurface()

    expect(mocks.requestBrowserFocus).toHaveBeenCalledWith({ pageId: 'page-9', target: 'webview' })
    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
  })

  it('does nothing without an active workspace', () => {
    mocks.state.activeWorktreeId = null

    focusActiveTabSurface()

    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
  })
})
