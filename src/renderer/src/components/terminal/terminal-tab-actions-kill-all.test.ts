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
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
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

  it('keeps the active room selected when a background terminal exits', () => {
    const closeTab = vi.fn()
    const setActiveTab = vi.fn()
    getStateMock.mockReturnValue(
      baseState({
        tabsByWorktree: { wt: [{ id: 'terminal-1' }, { id: 'terminal-2' }] },
        unifiedTabsByWorktree: {
          wt: [
            {
              id: 'unified-terminal-1',
              entityId: 'terminal-1',
              contentType: 'terminal',
              groupId: 'group-1'
            },
            {
              id: 'unified-terminal-2',
              entityId: 'terminal-2',
              contentType: 'terminal',
              groupId: 'group-1'
            },
            { id: 'room-tab', entityId: 'room-1', contentType: 'room', groupId: 'group-1' }
          ]
        },
        groupsByWorktree: {
          wt: [
            {
              id: 'group-1',
              activeTabId: 'room-tab',
              tabOrder: ['unified-terminal-1', 'unified-terminal-2', 'room-tab']
            }
          ]
        },
        activeGroupIdByWorktree: { wt: 'group-1' },
        closeTab,
        setActiveTab
      })
    )

    closeTerminalTab('terminal-1', { reason: 'pty-exit' })

    expect(closeTab).toHaveBeenCalledWith('terminal-1', { reason: 'pty-exit' })
    expect(setActiveTab).not.toHaveBeenCalled()
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
