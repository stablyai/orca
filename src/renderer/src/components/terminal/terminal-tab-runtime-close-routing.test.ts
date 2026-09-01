import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  closeWebRuntimeSessionTabMock,
  getStateMock,
  isWebRuntimeSessionActiveMock,
  resolveHostSessionTabIdForWebSessionTabMock
} = vi.hoisted(() => ({
  closeWebRuntimeSessionTabMock: vi.fn(),
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(),
  resolveHostSessionTabIdForWebSessionTabMock: vi.fn<() => string | null>(() => null)
}))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock,
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabId: vi.fn(() => false),
  toHostSessionTabId: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => 'epoch-1'),
  resolveHostSessionTabIdForWebSessionTab: resolveHostSessionTabIdForWebSessionTabMock
}))

import { closeTerminalTab } from './terminal-tab-actions'

describe('closeTerminalTab runtime evidence routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)
  })

  it('routes a remote PTY close while the worktree catalog is absent', () => {
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockImplementation(
      (environmentId: string) => environmentId === 'owner-runtime'
    )
    getStateMock.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: 'focused-runtime',
        skipCloseTerminalWithRunningProcessConfirm: true
      },
      repos: [],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'host-tab-1',
            ptyId: 'remote:owner-runtime@@terminal-1',
            worktreeId: 'wt-1'
          }
        ]
      },
      unifiedTabsByWorktree: {},
      activeWorktreeId: 'wt-1',
      activeTabId: 'host-tab-1',
      openFiles: [],
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('host-tab-1')

    expect(closeTab).toHaveBeenCalledWith('host-tab-1', {
      reason: undefined,
      remoteCloseOwnedByHost: true
    })
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'host-tab-1',
      environmentId: 'owner-runtime',
      reason: 'user'
    })
  })

  it('fails closed when live PTY bindings name conflicting runtime owners', () => {
    const closeTab = vi.fn()
    const onCancel = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'runtime-a' },
      repos: [{ id: 'repo-1', executionHostId: 'runtime:runtime-a', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'host-tab-1',
            ptyId: 'remote:runtime-a@@terminal-1',
            worktreeId: 'wt-1'
          }
        ]
      },
      ptyIdsByTabId: { 'host-tab-1': ['remote:runtime-b@@terminal-2'] },
      unifiedTabsByWorktree: {},
      closeTab
    })

    closeTerminalTab('host-tab-1', { onCancel })

    expect(onCancel).toHaveBeenCalledOnce()
    expect(closeTab).not.toHaveBeenCalled()
    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
  })

  it('does not route a close from a persisted layout binding alone', () => {
    const closeTab = vi.fn()
    const onCancel = vi.fn()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      repos: [],
      tabsByWorktree: {
        'wt-1': [{ id: 'host-tab-1', ptyId: null, worktreeId: 'wt-1' }]
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        'host-tab-1': {
          activeLeafId: 'leaf-1',
          ptyIdsByLeafId: { 'leaf-1': 'remote:stale-runtime@@terminal-1' }
        }
      },
      unifiedTabsByWorktree: {},
      closeTab
    })

    closeTerminalTab('host-tab-1', { onCancel })

    expect(onCancel).toHaveBeenCalledOnce()
    expect(closeTab).not.toHaveBeenCalled()
    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
  })
})
