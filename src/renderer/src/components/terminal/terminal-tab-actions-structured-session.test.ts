import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeStructuredAgentSession: vi.fn(),
  closeTab: vi.fn(),
  getState: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(() => null),
  toHostSessionTabId: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive,
  toHostSessionTabId: mocks.toHostSessionTabId
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => 'epoch-1'),
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeStructuredAgentSession
}))

import { closeTerminalTab } from './terminal-tab-actions'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.closeStructuredAgentSession.mockResolvedValue('closed')
  mocks.isWebRuntimeSessionActive.mockReturnValue(false)
})

describe('structured session disposal from terminal close', () => {
  it('disposes the native owner when an adopted TUI tab closes from chat view', async () => {
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { 'wt-1': [{ id: 'terminal-1' }, { id: 'terminal-2' }] },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            entityId: 'terminal-1',
            contentType: 'terminal',
            structuredSessionId: 'codex-adopted-1',
            viewMode: 'chat'
          }
        ]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'terminal-2',
      openFiles: [],
      browserTabsByWorktree: {},
      closeTab: mocks.closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('terminal-1')

    await vi.waitFor(() =>
      expect(mocks.closeStructuredAgentSession).toHaveBeenCalledWith(
        { kind: 'local' },
        'codex-adopted-1'
      )
    )
  })

  it('keeps natural adopted-TUI exits on the ownership reconciliation path', () => {
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { 'wt-1': [{ id: 'terminal-1' }, { id: 'terminal-2' }] },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            entityId: 'terminal-1',
            contentType: 'terminal',
            structuredSessionId: 'codex-adopted-1',
            viewMode: 'chat'
          }
        ]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'terminal-2',
      openFiles: [],
      browserTabsByWorktree: {},
      closeTab: mocks.closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('terminal-1', { reason: 'pty-exit' })

    expect(mocks.closeStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('retries a transient structured-owner close after the tab is removed', async () => {
    vi.useFakeTimers()
    try {
      mocks.closeStructuredAgentSession
        .mockRejectedValueOnce(new Error('host unavailable'))
        .mockResolvedValueOnce('closed')
      mocks.getState.mockReturnValue({
        settings: { activeRuntimeEnvironmentId: null },
        tabsByWorktree: { 'wt-1': [{ id: 'terminal-1' }, { id: 'terminal-2' }] },
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              entityId: 'terminal-1',
              contentType: 'terminal',
              structuredSessionId: 'codex-adopted-1',
              viewMode: 'chat'
            }
          ]
        },
        activeWorktreeId: 'wt-1',
        activeTabId: 'terminal-2',
        openFiles: [],
        browserTabsByWorktree: {},
        closeTab: mocks.closeTab,
        setActiveTab: vi.fn()
      })

      closeTerminalTab('terminal-1')
      await vi.advanceTimersByTimeAsync(250)
      expect(mocks.closeStructuredAgentSession).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
