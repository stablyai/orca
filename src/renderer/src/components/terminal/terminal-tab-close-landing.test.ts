import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  activateWebRuntimeSessionTabMock,
  closeWebRuntimeSessionTabMock,
  createWebRuntimeSessionTerminalMock,
  getLatestWebSessionTabsPublicationEpochMock,
  getStateMock,
  isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabIdMock,
  resolveHostSessionTabIdForWebSessionTabMock,
  toHostSessionTabIdMock
} = vi.hoisted(() => ({
  activateWebRuntimeSessionTabMock: vi.fn(),
  closeWebRuntimeSessionTabMock: vi.fn(),
  createWebRuntimeSessionTerminalMock: vi.fn(),
  getLatestWebSessionTabsPublicationEpochMock: vi.fn(() => 'epoch-1'),
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(),
  isWebTerminalSurfaceTabIdMock: vi.fn(() => false),
  resolveHostSessionTabIdForWebSessionTabMock: vi.fn<() => string | null>(() => null),
  toHostSessionTabIdMock: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: activateWebRuntimeSessionTabMock,
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock,
  createWebRuntimeSessionTerminal: createWebRuntimeSessionTerminalMock,
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabId: isWebTerminalSurfaceTabIdMock,
  toHostSessionTabId: toHostSessionTabIdMock
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: getLatestWebSessionTabsPublicationEpochMock,
  resolveHostSessionTabIdForWebSessionTab: resolveHostSessionTabIdForWebSessionTabMock
}))

import { closeTerminalTab } from './terminal-tab-actions'

function unifiedTab(id: string, entityId: string, contentType: 'terminal' | 'browser') {
  return {
    id,
    entityId,
    contentType,
    groupId: 'group-1',
    worktreeId: 'wt-1',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('closeTerminalTab landing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)
    isWebTerminalSurfaceTabIdMock.mockReturnValue(false)
  })

  it('lands on the browser tab used last, not the first one, when the last terminal closes', () => {
    const setActiveBrowserTab = vi.fn()
    const setActiveTabType = vi.fn()
    const setActiveWorktree = vi.fn()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { 'wt-1': [{ id: 'terminal-1' }] },
      unifiedTabsByWorktree: {
        'wt-1': [
          unifiedTab('unified-browser-first', 'browser-first', 'browser'),
          unifiedTab('unified-browser-recent', 'browser-recent', 'browser'),
          unifiedTab('unified-terminal', 'terminal-1', 'terminal')
        ]
      },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: 'unified-terminal',
            tabOrder: ['unified-browser-first', 'unified-browser-recent', 'unified-terminal'],
            recentTabIds: ['unified-browser-first', 'unified-browser-recent', 'unified-terminal']
          }
        ]
      },
      browserTabsByWorktree: {
        'wt-1': [{ id: 'browser-first' }, { id: 'browser-recent' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'terminal-1',
      openFiles: [],
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      setActiveBrowserTab,
      setActiveFile: vi.fn(),
      setActiveTabType,
      setActiveWorktree,
      focusGroup: vi.fn(),
      activateTab: vi.fn()
    })

    closeTerminalTab('terminal-1')

    expect(setActiveBrowserTab).toHaveBeenCalledWith('browser-recent')
    expect(setActiveTabType).toHaveBeenCalledWith('browser')
    expect(setActiveWorktree).not.toHaveBeenCalled()
  })

  it('keeps the first-browser-tab fallback when the group has no other visited tab', () => {
    const setActiveBrowserTab = vi.fn()
    const setActiveTabType = vi.fn()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { 'wt-1': [{ id: 'terminal-1' }] },
      unifiedTabsByWorktree: {
        'wt-1': [unifiedTab('unified-terminal', 'terminal-1', 'terminal')]
      },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: 'unified-terminal',
            tabOrder: ['unified-terminal'],
            recentTabIds: ['unified-terminal']
          }
        ]
      },
      browserTabsByWorktree: {
        'wt-1': [{ id: 'browser-first' }, { id: 'browser-recent' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'terminal-1',
      openFiles: [],
      closeTab: vi.fn(),
      setActiveTab: vi.fn(),
      setActiveBrowserTab,
      setActiveFile: vi.fn(),
      setActiveTabType,
      setActiveWorktree: vi.fn(),
      focusGroup: vi.fn(),
      activateTab: vi.fn()
    })

    closeTerminalTab('terminal-1')

    expect(setActiveBrowserTab).toHaveBeenCalledWith('browser-first')
    expect(setActiveTabType).toHaveBeenCalledWith('browser')
  })
})
