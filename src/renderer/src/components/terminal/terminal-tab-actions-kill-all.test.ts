import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, closeWebRuntimeSessionTabMock, isWebRuntimeSessionActiveMock } = vi.hoisted(
  () => ({
    getStateMock: vi.fn(),
    closeWebRuntimeSessionTabMock: vi.fn(),
    isWebRuntimeSessionActiveMock: vi.fn(() => false)
  })
)

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock,
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock,
  toHostSessionTabId: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  resolveHostSessionTabIdForWebSessionTab: vi.fn(() => null)
}))

import { closeTerminalTab } from './terminal-tab-actions'

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab: true },
    repos: [{ id: 'repo', executionHostId: 'local', connectionId: null }],
    worktreesByRepo: { repo: [{ id: 'wt', repoId: 'repo' }] },
    tabsByWorktree: { wt: [{ id: 'terminal-1' }] },
    unifiedTabsByWorktree: {},
    activeWorktreeId: 'wt',
    activeTabId: 'terminal-1',
    openFiles: [],
    browserTabsByWorktree: {},
    closeTab: vi.fn(),
    closeUnifiedTab: vi.fn(),
    setActiveFile: vi.fn(),
    setActiveBrowserTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveWorktree: vi.fn(),
    requestPinnedTabCloseConfirm: vi.fn(),
    createTab: vi.fn(),
    closeFile: vi.fn(),
    closeBrowserTab: vi.fn(),
    ...overrides
  }
}

describe('closeTerminalTab kill-all routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
  })

  it('force-closes a pinned terminal without opening a second confirmation', () => {
    const closeTab = vi.fn()
    const closeUnifiedTab = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    getStateMock.mockReturnValue(
      baseState({
        tabsByWorktree: {},
        unifiedTabsByWorktree: {
          wt: [
            {
              id: 'visible-pinned',
              entityId: 'terminal-1',
              contentType: 'terminal',
              isPinned: true
            }
          ]
        },
        closeTab,
        closeUnifiedTab,
        requestPinnedTabCloseConfirm
      })
    )

    closeTerminalTab('terminal-1', { force: true })

    expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
    expect(closeTab).toHaveBeenCalledWith('terminal-1', { reason: undefined })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('routes the last active terminal to an existing editor without closing it', () => {
    const state = baseState({
      openFiles: [{ id: 'editor-1', worktreeId: 'wt' }]
    })
    getStateMock.mockReturnValue(state)

    closeTerminalTab('terminal-1', { force: true })

    expect(state.closeTab).toHaveBeenCalledWith('terminal-1')
    expect(state.setActiveFile).toHaveBeenCalledWith('editor-1')
    expect(state.setActiveTabType).toHaveBeenCalledWith('editor')
    expect(state.closeFile).not.toHaveBeenCalled()
    expect(state.closeBrowserTab).not.toHaveBeenCalled()
    expect(state.setActiveWorktree).not.toHaveBeenCalled()
    expect(state.createTab).not.toHaveBeenCalled()
  })

  it('routes the last active terminal to an existing browser when no editor exists', () => {
    const state = baseState({
      browserTabsByWorktree: { wt: [{ id: 'browser-1' }] }
    })
    getStateMock.mockReturnValue(state)

    closeTerminalTab('terminal-1', { force: true })

    expect(state.setActiveBrowserTab).toHaveBeenCalledWith('browser-1')
    expect(state.setActiveTabType).toHaveBeenCalledWith('browser')
    expect(state.closeBrowserTab).not.toHaveBeenCalled()
    expect(state.setActiveWorktree).not.toHaveBeenCalled()
    expect(state.createTab).not.toHaveBeenCalled()
  })

  it('deactivates after the last active terminal when no other content exists', () => {
    const state = baseState()
    getStateMock.mockReturnValue(state)

    closeTerminalTab('terminal-1', { force: true })

    expect(state.setActiveWorktree).toHaveBeenCalledWith(null)
    expect(state.setActiveFile).not.toHaveBeenCalled()
    expect(state.setActiveBrowserTab).not.toHaveBeenCalled()
    expect(state.createTab).not.toHaveBeenCalled()
  })
})
